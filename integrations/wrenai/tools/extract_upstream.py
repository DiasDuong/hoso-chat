"""Copy an explicit, byte-preserving subset from the user's local Wren checkout."""
from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
import shutil

KIT = Path(__file__).resolve().parents[1]
RUNTIME = [
    "__init__.py", "engine.py", "config.py", "policy.py", "read_only.py",
    "connector/__init__.py", "connector/base.py", "connector/factory.py",
    "connector/postgres.py", "connector/duckdb.py",
    "mdl/__init__.py", "mdl/cte_rewriter.py", "mdl/wren_dialect.py",
    "mdl/clickhouse_compat.py", "model/__init__.py", "model/data_source.py",
    "model/error.py",
]
REFERENCES = [
    "core/wren/pyproject.toml", "core/wren/uv.lock",
    "core/wren-mdl/mdl.schema.json", ".release-please-manifest.json",
    "docs/core/reference/architecture.md", "docs/core/reference/mdl.md",
    "docs/core/concepts/what_is_mdl.md", "docs/core/concepts/oss_vs_commercial.md",
    "docs/core/guides/model.md", "docs/core/guides/connect.md",
    "core/wren/src/wren/skills_content/usage/SKILL.md",
    "core/wren/src/wren/skills_content/usage/references/wren-sql.md",
    "core/wren/src/wren/skills_content/generate-mdl/SKILL.md",
    "examples/v5-jaffle/wren_project.yml",
    "examples/v5-jaffle/models/orders/metadata.yml",
    "examples/v5-jaffle/relationships.yml",
    "examples/v5-jaffle/cubes/order_metrics/metadata.yml",
    "examples/v5-jaffle/knowledge/rules/business-rules.md",
    "core/wren/tests/unit/test_engine.py", "core/wren/tests/unit/test_policy.py",
    "core/wren/tests/unit/test_read_only.py",
]
LICENSES = ["LICENSE", "LICENSE-APACHE-2.0", "LICENSE-CC-BY-4.0"]


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def extract(root: Path) -> dict:
    root = root.resolve(strict=True)
    entries = []
    pairs = [(f"core/wren/src/wren/{p}", f"upstream/runtime/wren/{p}") for p in RUNTIME]
    pairs += [(p, f"upstream/reference/{p}") for p in REFERENCES]
    pairs += [(p, f"upstream/licenses/{p}") for p in LICENSES]
    # Resolve and check every path before copying any file.
    resolved = []
    for relative, target in pairs:
        source = (root / relative).resolve(strict=True)
        source.relative_to(root)
        destination = (KIT / target).resolve()
        destination.relative_to(KIT)
        resolved.append((relative, target, source, destination))
    for relative, target, source, destination in resolved:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        entries.append({
            "source": relative, "destination": target, "sha256": digest(source),
            "bytes": source.stat().st_size,
            "license": "CC-BY-4.0" if relative.startswith("docs/") else "Apache-2.0",
        })
    release = json.loads((root / ".release-please-manifest.json").read_text(encoding="utf-8"))
    manifest = {
        "source_root": str(root), "source_revision": None,
        "revision_note": "User-supplied ZIP checkout; no .git metadata. File hashes identify this snapshot.",
        "extracted_at": datetime.now(timezone.utc).isoformat(),
        "upstream_url": "https://github.com/Canner/WrenAI",
        "versions": release, "runtime_scope": ["postgres planning", "postgres connector reference", "duckdb connector reference"],
        "files": entries,
    }
    (KIT / "upstream-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def verify(source_root: Path | None = None) -> list[str]:
    manifest = json.loads((KIT / "upstream-manifest.json").read_text(encoding="utf-8"))
    failures = []
    for item in manifest["files"]:
        destination = KIT / item["destination"]
        if not destination.is_file() or digest(destination) != item["sha256"]:
            failures.append(item["destination"])
        if source_root:
            original = source_root / item["source"]
            if not original.is_file() or digest(original) != item["sha256"]:
                failures.append("source:" + item["source"])
    return failures


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path)
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    if args.verify:
        errors = verify(args.source)
        print(json.dumps({"verified": not errors, "mismatches": errors}))
        raise SystemExit(bool(errors))
    if not args.source:
        parser.error("--source is required for extraction")
    result = extract(args.source)
    print(json.dumps({"copied_files": len(result["files"]), "total_bytes": sum(f["bytes"] for f in result["files"])}))
