"""Report allocation cells whose `raw` field still contains line-soup the parser
couldn't fully decompose. Useful for manual review after first extraction.

Heuristic: a `raw` cell with substantially more non-whitespace lines than
(services + 1 frequency-range-line + 1 cell-footnote-line) likely lost content
during parsing. The threshold tolerates +1 over expected (one extra line for
parenthetical qualifiers, multi-line service names, etc.) before flagging.
"""

from __future__ import annotations

import pathlib
import sys

from ruamel.yaml import YAML


def main(yaml_path: pathlib.Path) -> int:
    yaml = YAML(typ="rt")
    with yaml_path.open("r") as f:
        doc = yaml.load(f)

    suspicious = 0
    for collection in ("au_allocations", "region_allocations"):
        for row in doc.get(collection, []):
            raw_lines = [ln for ln in row["raw"].splitlines() if ln.strip()]
            services = row.get("services", []) or []
            footnotes = row.get("footnotes", []) or []
            expected_max_lines = 1 + len(services) + (1 if footnotes else 0)
            if (
                "(Not allocated)" not in row["raw"]
                and "(reserved)" not in row["raw"].lower()
                and len(raw_lines) > expected_max_lines + 1
            ):
                print(
                    f"[{collection}] page {row['page']}, "
                    f"{row['freq_start_hz']}–{row['freq_end_hz']} Hz: "
                    f"{len(raw_lines)} lines vs {len(services)} services + "
                    f"{len(footnotes)} cell-level footnotes"
                )
                print(f"  raw: {row['raw']!r}")
                suspicious += 1

    print(f"\n{suspicious} suspicious row(s)")
    return 0 if suspicious < 50 else 1


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python audit.py <path/to/yaml>", file=sys.stderr)
        sys.exit(1)
    sys.exit(main(pathlib.Path(sys.argv[1])))
