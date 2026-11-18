import json
import os
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import patch
import http.client

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bridge'))
import query_service as service


class Cursor:
    def __init__(self, role=None):
        self.calls = []
        self.role = role or ('on', False, False, False, False, False, False)
        self.description = [type('Column', (), {'name': 'batches', 'type_code': 20})()]
    def __enter__(self): return self
    def __exit__(self, *_): pass
    def execute(self, sql): self.calls.append(sql)
    def fetchone(self): return self.role
    def fetchmany(self, _): return [(12,)]


class Connection:
    def __init__(self, cursor): self.c = cursor
    def __enter__(self): return self
    def __exit__(self, *_): pass
    def transaction(self): return self
    def cursor(self): return self.c


class QueryTests(unittest.TestCase):
    def test_readonly_transaction_and_scope_are_used(self):
        cursor = Cursor()
        settings = {'WREN_PG_HOST': 'fixture', 'WREN_PG_DATABASE': 'fixture', 'WREN_PG_USER': 'fixture_ro', 'WREN_PG_PASSWORD': 'synthetic'}
        captured = {}
        def connect(**kwargs): captured.update(kwargs); return Connection(cursor)
        with patch.dict(os.environ, settings, clear=True):
            result = service.execute_query({'sql': 'SELECT COUNT(*) AS batches FROM hub_intake_batches', 'company_id': 'STL'}, connect)
        self.assertTrue(result['executed'])
        self.assertEqual(result['rows'], [{'batches': 12}])
        self.assertEqual(cursor.calls[0], 'SET TRANSACTION READ ONLY')
        self.assertIn('default_transaction_read_only=on', captured['options'])
        self.assertIn('statement_timeout=3000', captured['options'])
        self.assertNotIn('planned_sql', result)

    def test_privileged_role_is_refused_before_user_query(self):
        cursor = Cursor(('on', True, False, False, False, False, False))
        settings = {'WREN_PG_HOST': 'fixture', 'WREN_PG_DATABASE': 'fixture', 'WREN_PG_USER': 'fixture_ro', 'WREN_PG_PASSWORD': 'synthetic'}
        with patch.dict(os.environ, settings, clear=True), self.assertRaises(service.AdmissionError):
            service.execute_query({'sql': 'SELECT COUNT(*) FROM hub_intake_batches', 'company_id': 'ALL'}, lambda **_: Connection(cursor))
        self.assertEqual(len(cursor.calls), 2)

    def test_no_fallback_to_operational_credentials(self):
        with self.assertRaises(service.AdmissionError):
            service.connection_settings({'PG_USER': 'operational', 'PG_PASSWORD': 'synthetic'})

    def test_raw_plan_or_connection_cannot_be_submitted(self):
        with self.assertRaises(service.AdmissionError):
            service.execute_query({'planned_sql': 'SELECT 1', 'company_id': 'ALL'})

    def test_http_auth_and_query_contract(self):
        token = 'x' * 40
        called = []
        server = service.make_server(port=0, token=token, execute=lambda value: called.append(value) or {'success': True, 'executed': True})
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            def request(auth=None):
                c = http.client.HTTPConnection('127.0.0.1', server.server_address[1])
                headers = {'Content-Type': 'application/json'}
                if auth: headers['Authorization'] = 'Bearer ' + auth
                c.request('POST', '/query', json.dumps({'sql': 'SELECT COUNT(*) FROM hub_intake_batches', 'company_id': 'STL'}), headers)
                r = c.getresponse(); status = r.status; r.read(); c.close(); return status
            with patch.dict(os.environ, {'WREN_BI_EXECUTION_ENABLED': 'true'}):
                self.assertEqual(request(), 401)
                self.assertEqual(request('wrong'), 401)
                self.assertEqual(request(token), 200)
            self.assertEqual(len(called), 1)
        finally: server.shutdown(); server.server_close(); thread.join()


if __name__ == '__main__': unittest.main(verbosity=2)
