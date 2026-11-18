"""Private, authenticated Wren query service. Every query is replanned server-side."""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import base64
import os
from pathlib import Path
import secrets
import threading
import time
import uuid

from plan_worker import AdmissionError, BRANCHES, KIT, manifest_for_company, plan_request
from sqlglot import exp, parse_one
from wren.policy import validate_planned_sql
from wren.model.error import WrenError

MAX_BODY = 65536
APPROVED_TABLES = {"public.documents", "public.hr_intake_batches", "public.hr_employee_staging"}


def catalog() -> dict:
    model = manifest_for_company("STL")
    return {"version": "sotrans-wren-1", "models": [{"name": m["name"], "description": m.get("properties", {}).get("description", ""), "columns": m["columns"]} for m in model["models"]], "business_rules": (KIT / "models/business-rules.md").read_text(encoding="utf-8")}


def connection_settings(environment=None) -> dict:
    environment = os.environ if environment is None else environment
    required = ["WREN_PG_HOST", "WREN_PG_DATABASE", "WREN_PG_USER"]
    password = environment.get("WREN_PG_PASSWORD")
    if not password and environment.get("WREN_PG_PASSWORD_BASE64"):
        password = base64.b64decode(environment["WREN_PG_PASSWORD_BASE64"], validate=True).decode('utf-8')
    if any(not environment.get(k) for k in required) or not password:
        raise AdmissionError("READONLY_CONNECTION_NOT_CONFIGURED")
    return {"host": environment["WREN_PG_HOST"], "port": int(environment.get("WREN_PG_PORT", "5432")),
            "dbname": environment["WREN_PG_DATABASE"], "user": environment["WREN_PG_USER"], "password": password,
            "connect_timeout": 5, "options": "-c default_transaction_read_only=on -c statement_timeout=3000 -c idle_in_transaction_session_timeout=5000 -c timezone=Asia/Ho_Chi_Minh"}


def json_value(value):
    if isinstance(value, (date, datetime, uuid.UUID)): return str(value)
    if isinstance(value, Decimal): return str(value)  # Preserve precision on transport.
    if type(value) is int and abs(value) > 9007199254740991: return str(value)
    if value is None or isinstance(value, (str, int, float, bool)): return value
    raise AdmissionError("UNSUPPORTED_RESULT_TYPE")


def execute_query(request: dict, connect=None) -> dict:
    if set(request) - {"sql", "company_id", "limit", "request_id"}: raise AdmissionError("INVALID_REQUEST")
    plan = plan_request({"action": "plan", "sql": request.get("sql"), "company_id": request.get("company_id"), "limit": request.get("limit", 100)})
    # Never accept planned SQL, connection settings or manifests from the caller.
    validate_planned_sql(plan["planned_sql"], "postgres")
    if not set(plan["source_tables"]).issubset(APPROVED_TABLES) or not plan["source_tables"]: raise AdmissionError("SOURCE_NOT_APPROVED")
    if connect is None:
        import psycopg
        connect = psycopg.connect
    started = time.monotonic()
    with connect(**connection_settings()) as connection:
        with connection.transaction():
            with connection.cursor() as cursor:
                cursor.execute("SET TRANSACTION READ ONLY")
                cursor.execute("SELECT current_setting('transaction_read_only'), rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, has_schema_privilege(current_user, 'public', 'CREATE'), has_table_privilege(current_user, 'public.users', 'UPDATE') FROM pg_roles WHERE rolname=current_user")
                role = cursor.fetchone()
                if not role or role[0] != 'on' or any(role[1:]): raise AdmissionError("DATABASE_ROLE_NOT_LEAST_PRIVILEGE")
                cursor.execute(plan["planned_sql"])
                columns = [c.name for c in cursor.description]
                numeric_columns = [c.name for c in cursor.description if c.type_code in {20, 21, 23, 700, 701, 1700}]
                if len(columns) != len(set(columns)): raise AdmissionError("DUPLICATE_RESULT_COLUMNS")
                values = cursor.fetchmany(plan["row_limit"] + 1)
                rows = [{k: json_value(v) for k, v in zip(columns, row)} for row in values[:plan["row_limit"]]]
    ast = parse_one(request["sql"], dialect="postgres")
    metrics = {}
    for projection in ast.expressions:
        body = projection.this if isinstance(projection, exp.Alias) else projection
        if isinstance(body, exp.AggFunc): metrics[projection.alias_or_name] = body.key.upper()
    return {"success": True, "engine": "wren", "executed": True, "company_id": plan["company_id"],
            "rows": rows, "columns": columns, "numeric_columns": numeric_columns, "metric_functions": metrics, "row_limit": plan["row_limit"],
            "returned_rows": len(rows), "may_be_truncated": len(values) >= plan["row_limit"],
            "source_tables": plan["source_tables"], "models": plan["models"], "manifest_sha256": plan["manifest_sha256"],
            "execution_time_ms": round((time.monotonic() - started) * 1000), "request_id": request.get("request_id")}


def make_server(host="127.0.0.1", port=8091, token=None, execute=None):
    token = os.environ.get("WREN_SERVICE_TOKEN") if token is None else token
    if not token or len(token) < 32: raise AdmissionError("SERVICE_TOKEN_NOT_CONFIGURED")
    execute = execute_query if execute is None else execute
    capacity = threading.BoundedSemaphore(4)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        def setup(self):
            super().setup()
            self.connection.settimeout(15)

        def log_message(self, *_): pass

        def answer(self, code, data):
            payload = json.dumps(data, ensure_ascii=False, allow_nan=False).encode()
            self.send_response(code); self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload))); self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close"); self.end_headers(); self.wfile.write(payload)
            self.close_connection = True

        def authenticated(self):
            return secrets.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token)

        def do_GET(self):
            if self.path == "/health": return self.answer(200, {"status": "ok", "engine": "wren", "execution_enabled": os.environ.get("WREN_BI_EXECUTION_ENABLED") == "true"})
            if not self.authenticated(): return self.answer(401, {"success": False, "code": "UNAUTHORIZED"})
            if self.path == "/catalog": return self.answer(200, catalog())
            self.answer(404, {"success": False, "code": "NOT_FOUND"})

        def do_POST(self):
            if not self.authenticated(): return self.answer(401, {"success": False, "code": "UNAUTHORIZED"})
            if self.path != "/query": return self.answer(404, {"success": False, "code": "NOT_FOUND"})
            if os.environ.get("WREN_BI_EXECUTION_ENABLED") != "true": return self.answer(503, {"success": False, "code": "EXECUTION_DISABLED"})
            if not capacity.acquire(blocking=False): return self.answer(429, {"success": False, "code": "CONCURRENCY_LIMIT"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if self.headers.get('Transfer-Encoding') or not 1 <= length <= MAX_BODY: raise AdmissionError("INVALID_REQUEST_SIZE")
                request = json.loads(self.rfile.read(length))
                if not isinstance(request, dict): raise AdmissionError("INVALID_REQUEST")
                self.answer(200, execute(request))
            except (AdmissionError, ValueError, TypeError) as error:
                code = str(error) if isinstance(error, AdmissionError) else "INVALID_REQUEST"
                self.answer(400, {"success": False, "code": code})
            except WrenError as error:
                self.answer(400, {"success": False, "code": error.error_code.name})
            except Exception:
                self.answer(503, {"success": False, "code": "READONLY_QUERY_FAILED"})
            finally: capacity.release()

    return ThreadingHTTPServer((host, port), Handler)


if __name__ == "__main__":
    server = make_server(os.environ.get("WREN_SERVICE_HOST", "127.0.0.1"), int(os.environ.get("WREN_SERVICE_PORT", "8091")))
    server.serve_forever()
