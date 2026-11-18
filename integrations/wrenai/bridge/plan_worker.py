"""One-request planning bridge. No database connection, execution, HTTP or LLM."""
from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
KIT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(KIT / "upstream/runtime"))

from sqlglot import exp, parse_one
from sqlglot.errors import OptimizeError
from sqlglot.optimizer.qualify import qualify
from wren.config import WrenConfig
from wren.engine import WrenEngine
from wren.model.error import WrenError
from wren.read_only import require_source_tables, validate_read_only_query

BRANCHES = {"STL": "sotrans_logistics", "VTX": "vietranstimex", "SWC": "sowatco", "ALL": "all"}
MAX_REQUEST_BYTES = 65536
MAX_SQL_CHARS = 8000


class AdmissionError(ValueError):
    pass


def manifest_for_company(company: str) -> dict:
    if company not in BRANCHES:
        raise AdmissionError("INVALID_COMPANY")
    template = (KIT / "models/hub.mdl.template.json").read_text(encoding="utf-8")
    # Values are host-selected enum literals, never arbitrary text or SQL from a user.
    return json.loads(template.replace("__COMPANY__", company).replace("__BRANCH__", BRANCHES[company]))


def plan_request(request: dict) -> dict:
    if not isinstance(request, dict) or set(request) - {"action", "company_id", "sql", "limit"}:
        raise AdmissionError("INVALID_REQUEST")
    if request.get("action") != "plan":
        raise AdmissionError("EXECUTION_NOT_ENABLED")
    company = request.get("company_id")
    if not isinstance(company, str) or company not in BRANCHES:
        raise AdmissionError("INVALID_COMPANY")
    sql = request.get("sql")
    if not isinstance(sql, str) or not sql.strip() or len(sql) > MAX_SQL_CHARS:
        raise AdmissionError("INVALID_SQL_SIZE")
    limit = request.get("limit", 100)
    if type(limit) is not int or not 1 <= limit <= 500:
        raise AdmissionError("INVALID_LIMIT")
    validate_read_only_query(sql, "postgres")
    ast = parse_one(sql, dialect="postgres")
    if any(t.db or t.catalog for t in ast.find_all(exp.Table)):
        raise AdmissionError("QUALIFIED_TABLE_NOT_ALLOWED")
    if any(w.args.get("recursive") for w in ast.find_all(exp.With)):
        raise AdmissionError("RECURSIVE_QUERY_NOT_ALLOWED")
    sources = require_source_tables(ast, "postgres")
    manifest = manifest_for_company(company)
    # A reachable integration boundary: upstream 0.18.0 dry_plan did not reject
    # SELECT citizen_id FROM hub_staged_records in the extracted-source test.
    # Validate the caller's columns against the exposed model schema here.
    schema = {m["name"]: {c["name"]: c["type"] for c in m["columns"]} for m in manifest["models"]}
    try:
        qualify(ast.copy(), dialect="postgres", schema=schema, infer_schema=False,
                validate_qualify_columns=True, allow_partial_qualification=False)
    except OptimizeError as error:
        raise AdmissionError("INVALID_MODEL_OR_COLUMN") from error
    # Preserve a smaller literal LIMIT. Never accept a dynamic LIMIT expression.
    current_limit = ast.args.get("limit")
    if current_limit is not None:
        expression = current_limit.expression
        if not isinstance(expression, exp.Literal) or not expression.is_int:
            raise AdmissionError("INVALID_LIMIT")
        requested = int(expression.this)
        if requested < 1:
            raise AdmissionError("INVALID_LIMIT")
        limit = min(limit, requested)
    ast = ast.limit(limit)
    raw_manifest = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
    encoded = base64.b64encode(raw_manifest).decode("ascii")
    config = WrenConfig(strict_mode=True, denied_functions=frozenset({"pg_sleep", "set_config", "dblink", "pg_read_file"}))
    # Empty connection_info and dry_plan never create a connector.
    with WrenEngine(encoded, "postgres", {}, fallback=False, config=config) as engine:
        planned_sql = engine.dry_plan(ast.sql(dialect="postgres"))
    planned_ast = parse_one(planned_sql, dialect="postgres")
    physical = sorted({f"{t.db}.{t.name}" for t in planned_ast.find_all(exp.Table) if t.db})
    return {
        "success": True, "mode": "plan-only", "executed": False,
        "company_id": company, "planned_sql": planned_sql, "row_limit": limit,
        "models": sources, "source_tables": physical,
        "manifest_sha256": hashlib.sha256(raw_manifest).hexdigest(),
        "runtime": {"source_package": "wrenai", "source_version": "0.18.0", "binding_version": "0.8.2"},
    }


def main() -> int:
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        if len(raw) > MAX_REQUEST_BYTES:
            raise AdmissionError("REQUEST_TOO_LARGE")
        request = json.loads(raw)
        answer = plan_request(request)
    except AdmissionError as error:
        answer = {"success": False, "code": str(error), "executed": False}
    except WrenError as error:
        # Wren errors can contain expanded SQL / connector details: do not forward them.
        answer = {"success": False, "code": error.error_code.name, "executed": False}
    except (ValueError, TypeError):
        answer = {"success": False, "code": "INVALID_REQUEST", "executed": False}
    except Exception:
        answer = {"success": False, "code": "PLANNER_UNAVAILABLE", "executed": False}
    sys.stdout.write(json.dumps(answer, ensure_ascii=False) + "\n")
    return 0 if answer["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
