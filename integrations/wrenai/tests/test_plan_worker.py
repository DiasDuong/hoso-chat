"""Exercise extracted Wren code and the Hub bridge, without any live database."""
import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
KIT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("hub_plan_worker", KIT / "bridge/plan_worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

from jsonschema import Draft202012Validator
from sqlglot import exp, parse_one
from wren.engine import WrenEngine
from wren.model.error import WrenError


def request(sql, company="STL", limit=100, **extra):
    return {"action": "plan", "company_id": company, "sql": sql, "limit": limit, **extra}


class PlanningTests(unittest.TestCase):
    def test_01_real_engine_expands_intake_and_scope(self):
        result = worker.plan_request(request("SELECT SUM(total_files) AS files FROM hub_intake_batches", "SWC"))
        self.assertEqual(result["source_tables"], ["public.hr_intake_batches"])
        self.assertEqual(result["models"], ["hub_intake_batches"])
        self.assertFalse(result["executed"])
        ast = parse_one(result["planned_sql"], dialect="postgres")
        predicates = [n for n in ast.find_all(exp.EQ) if isinstance(n.this, exp.Column) and n.this.name == "company_id"]
        self.assertTrue(predicates)
        self.assertEqual({p.expression.this for p in predicates}, {"SWC"})

    def test_02_document_branch_and_group_scope_are_preserved(self):
        result = worker.plan_request(request("SELECT COUNT(DISTINCT doc_version_id) AS documents FROM hub_documents", "VTX"))
        self.assertEqual(result["source_tables"], ["public.documents"])
        ast = parse_one(result["planned_sql"], dialect="postgres")
        literals = {n.this for n in ast.find_all(exp.Literal)}
        self.assertIn("vietranstimex", literals)
        self.assertIn("all", literals)
        self.assertTrue(any(c.name == "deleted_at" for c in ast.find_all(exp.Column)))

    def test_03_staging_model_compiles(self):
        result = worker.plan_request(request("SELECT staging_status, COUNT(*) AS records FROM hub_staged_records GROUP BY staging_status"))
        self.assertEqual(result["source_tables"], ["public.hr_employee_staging"])

    def test_04_all_scopes_validate_against_extracted_schema(self):
        schema = json.loads((KIT / "upstream/reference/core/wren-mdl/mdl.schema.json").read_text(encoding="utf-8"))
        validator = Draft202012Validator(schema)
        for company in worker.BRANCHES:
            with self.subTest(company=company):
                validator.validate(worker.manifest_for_company(company))

    def test_05_unknown_model_rejected(self):
        with self.assertRaises(WrenError):
            worker.plan_request(request("SELECT COUNT(*) FROM employees"))

    def test_06_unmodeled_sensitive_column_rejected(self):
        with self.assertRaises(worker.AdmissionError):
            worker.plan_request(request("SELECT citizen_id FROM hub_staged_records"))

    def test_07_qualified_physical_table_rejected(self):
        with self.assertRaises(worker.AdmissionError):
            worker.plan_request(request("SELECT COUNT(*) FROM public.users"))

    def test_08_side_effects_and_multiple_statements_rejected(self):
        for sql in ["DELETE FROM hub_intake_batches", "SELECT * FROM hub_intake_batches; DROP TABLE users", "SELECT pg_sleep(5) FROM hub_intake_batches", "SELECT * INTO another FROM hub_intake_batches", "SELECT * FROM hub_intake_batches FOR UPDATE"]:
            with self.subTest(sql=sql), self.assertRaises(WrenError):
                worker.plan_request(request(sql))

    def test_09_literals_are_not_data_evidence(self):
        with self.assertRaises(WrenError):
            worker.plan_request(request("SELECT 123 AS total"))

    def test_10_unused_cte_is_not_data_evidence(self):
        with self.assertRaises(WrenError):
            worker.plan_request(request("WITH unused AS (SELECT * FROM hub_intake_batches) SELECT 123 AS total"))

    def test_11_row_limit_preserves_smaller_limit(self):
        result = worker.plan_request(request("SELECT total_files FROM hub_intake_batches LIMIT 3", limit=20))
        self.assertEqual(result["row_limit"], 3)
        self.assertEqual(parse_one(result["planned_sql"], dialect="postgres").args["limit"].expression.this, "3")

    def test_12_limits_are_bounded(self):
        for limit in [0, 501, True, "100"]:
            with self.subTest(limit=limit), self.assertRaises(worker.AdmissionError):
                worker.plan_request(request("SELECT * FROM hub_intake_batches", limit=limit))

    def test_13_company_is_an_enum_not_sql(self):
        with self.assertRaises(worker.AdmissionError):
            worker.plan_request(request("SELECT * FROM hub_intake_batches", company="STL' OR TRUE--"))

    def test_14_execute_action_and_connection_overrides_rejected(self):
        with self.assertRaises(worker.AdmissionError):
            worker.plan_request({"action": "execute", "company_id": "ALL", "sql": "SELECT * FROM hub_intake_batches"})
        with self.assertRaises(worker.AdmissionError):
            worker.plan_request(request("SELECT * FROM hub_intake_batches", connection_info={"host": "untrusted"}))

    def test_15_planning_does_not_open_a_connector(self):
        with patch.object(WrenEngine, "_get_connector", side_effect=AssertionError("No database access")) as connector:
            result = worker.plan_request(request("SELECT COUNT(*) AS batches FROM hub_intake_batches"))
            self.assertTrue(result["success"])
            connector.assert_not_called()

    def test_16_scopes_have_distinct_manifest_hashes(self):
        hashes = {worker.plan_request(request("SELECT COUNT(*) FROM hub_intake_batches", c))["manifest_sha256"] for c in worker.BRANCHES}
        self.assertEqual(len(hashes), 4)


if __name__ == "__main__":
    unittest.main(verbosity=2)
