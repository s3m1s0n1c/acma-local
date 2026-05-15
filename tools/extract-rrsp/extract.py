"""Extract the 2021 ACMA Spectrum Plan PDF to a canonical YAML.

Usage: python extract.py <path/to/pdf>

Reads pages 31–112 (allocations), 112–119 (Australian footnotes),
120–214 (international footnotes). Writes ../../seed/spectrum_plan_source.yaml.
"""

from __future__ import annotations

import hashlib
import pathlib
import re
import sys
from datetime import datetime, timezone

import pdfplumber
from ruamel.yaml import YAML

from cell_parser import parse_cell
from footnotes import is_running_header
from frequency import parse_range

EXTRACTOR_VERSION = "1.0.0"

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
OUTPUT_YAML = REPO_ROOT / "seed" / "spectrum_plan_source.yaml"

ALLOCATION_PAGES = range(30, 112)    # physical 31–112
AU_FOOTNOTE_PAGES = range(111, 119)  # physical 112–119; page 112 intentionally appears in both (split page)
INTL_FOOTNOTE_PAGES = range(119, 214) # physical 120–214


def _sha256(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _page_unit(page) -> str | None:
    text = page.extract_text() or ""
    for line in text.splitlines()[:5]:
        token = line.strip().lower()
        if token == "khz":
            return "kHz"
        if token == "mhz":
            return "MHz"
        if token == "ghz":
            return "GHz"
    return None


def _build_allocation_row(cell_text: str, unit: str, page: int) -> dict | None:
    parts = [p.strip() for p in cell_text.splitlines() if p.strip()]
    if not parts:
        return None
    first = parts[0]
    rest = "\n".join(parts[1:])
    try:
        start, end = parse_range(first, unit)
    except ValueError:
        return None
    parsed = parse_cell(rest)
    return {
        "freq_start_hz": start,
        "freq_end_hz": end,
        "unit": unit,
        "page": page,
        "services": parsed["services"],
        "footnotes": parsed["footnotes"],
        "raw": cell_text,
    }


def _extract_allocations(pdf) -> tuple[list[dict], list[dict]]:
    au_rows: list[dict] = []
    region_rows: list[dict] = []

    for page_num in ALLOCATION_PAGES:
        page = pdf.pages[page_num]
        unit = _page_unit(page)
        if not unit:
            continue
        tables = page.extract_tables()
        for tbl in tables:
            # pdfplumber replicates both header rows on every page: row 0 is
            # the column group labels ("Column 1: ITU Radio Regulation" etc.)
            # and row 1 is the sub-labels ("Region 1", "Region 2", …, "Australian
            # Table of Allocation").  Verified against page indices 30–32 and 105
            # (sampled kHz, MHz, and GHz band pages).  Skip both unconditionally.
            for row in tbl[2:]:
                if not any(row):
                    continue
                cells = (list(row) + [None] * 4)[:4]
                r1_cell, r2_cell, r3_cell, au_cell = cells

                if au_cell and au_cell.strip():
                    au_row = _build_allocation_row(au_cell, unit, page_num + 1)
                    if au_row:
                        au_rows.append(au_row)

                for region_idx, cell in enumerate([r1_cell, r2_cell, r3_cell], start=1):
                    if cell and cell.strip():
                        region_row = _build_allocation_row(cell, unit, page_num + 1)
                        if region_row:
                            region_row["region"] = region_idx
                            region_rows.append(region_row)

    return au_rows, region_rows


_AUS_REF_PATTERN = re.compile(r"^AUS\d+[A-Z]*$")
_INTL_REF_PATTERN = re.compile(r"^\d{1,3}[A-Z]{0,2}$")


def _discover_ref_x0(pdf, page_range, *, is_australian: bool) -> float | None:
    """Find the x0 (left-margin) position of footnote ref tokens.

    Scans the first three pages of the section and returns the MINIMUM x0
    among all words whose text matches the ref pattern.  Using minimum rather
    than the first match avoids picking up pattern-matching tokens that appear
    in running headers or inline within body text at larger x0 values (e.g. the
    standalone '4' in 'International Footnotes Part 4' at x0≈518).

    Real footnote refs sit at the left margin; body-text numbers like
    '1 625 kHz' are indented further right.
    """
    pattern = _AUS_REF_PATTERN if is_australian else _INTL_REF_PATTERN
    candidates: list[float] = []
    for page_num in list(page_range)[:3]:
        words = pdf.pages[page_num].extract_words(extra_attrs=["top"])
        for w in words:
            if pattern.match(w["text"]):
                candidates.append(float(w["x0"]))
    return min(candidates) if candidates else None


def _extract_footnotes(pdf, page_range, *, is_australian: bool) -> list[dict]:
    """Extract footnotes using positional (x0) analysis rather than line-text
    regex matching.  The old approach matched continuation lines that began with
    embedded numbers like '1 625 kHz' or '442 GHz', producing 41 corrupt
    international footnote entries.  Real ref tokens sit at the left margin
    (ref_x0); continuation lines start further right."""
    ref_x0 = _discover_ref_x0(pdf, page_range, is_australian=is_australian)
    if ref_x0 is None:
        return []

    TOLERANCE = 5.0
    LINE_TOP_TOLERANCE = 3.0
    pattern = _AUS_REF_PATTERN if is_australian else _INTL_REF_PATTERN

    out: list[dict] = []
    current_ref: str | None = None
    current_buf: list[str] = []
    current_page: int | None = None

    def flush() -> None:
        nonlocal current_ref, current_buf
        if current_ref is not None:
            text = " ".join(part.strip() for part in current_buf if part.strip())
            if text:
                out.append({"ref": current_ref, "text": text, "page": current_page})

    for page_num in page_range:
        page = pdf.pages[page_num]
        words = page.extract_words(extra_attrs=["top"])

        # Group words into lines by their 'top' coordinate (tolerance ~3 px).
        lines: list[list[dict]] = []
        for w in words:
            placed = False
            for line in lines:
                if abs(float(line[0]["top"]) - float(w["top"])) < LINE_TOP_TOLERANCE:
                    line.append(w)
                    placed = True
                    break
            if not placed:
                lines.append([w])

        # Sort words within each line by x0; sort lines top-to-bottom.
        for line in lines:
            line.sort(key=lambda w: float(w["x0"]))
        lines.sort(key=lambda ln: float(ln[0]["top"]))

        for line in lines:
            text = " ".join(w["text"] for w in line)
            stripped = text.strip()
            if not stripped:
                continue
            if is_running_header(stripped):
                continue
            first = line[0]
            # A new footnote starts only when the FIRST word in the line sits at
            # the left margin (within TOLERANCE) AND matches the ref pattern.
            # Body-text numbers like "1 625 kHz" appear as continuation lines
            # whose first word is indented (higher x0), so they fall through to
            # the else branch below.
            #
            # Extra guard: some footnotes contain multi-column frequency-range
            # tables where large MHz/GHz values are split across space boundaries
            # by the PDF renderer (e.g. "1 330–1 400 MHz" becomes the tokens
            # "1", "330–1", "400").  The lone "1" sits at the left margin and
            # matches the pattern, but the NEXT token always starts with
            # digits-then-dash (e.g. "330–"), which is never how real footnote
            # body text begins.  Detecting that guards against false ref starts.
            second_text = line[1]["text"] if len(line) > 1 else ""
            # Guard: a lone digit/short-number at the margin is a false ref
            # start when the next token on the same line also begins with a
            # digit.  This covers two PDF rendering artefacts:
            #
            # 1. Multi-column frequency tables split "1 330–1 400 MHz" into
            #    tokens "1", "330–1", "400" — second token starts with digit
            #    AND contains "–".
            # 2. Cross-reference numbers like "3 340.1 The allocation …"
            #    split into "3", "340.1", "The" — second token is a decimal.
            #
            # In both cases the second word starts with a digit, whereas real
            # footnote body text always starts with a capital letter or "(".
            is_body_fragment = not is_australian and bool(
                second_text and re.match(r"^\d", second_text)
            )
            if (
                abs(float(first["x0"]) - ref_x0) < TOLERANCE
                and pattern.match(first["text"])
                and not is_body_fragment
            ):
                flush()
                current_ref = first["text"]
                rest = " ".join(w["text"] for w in line[1:]).strip()
                current_buf = [rest] if rest else []
                current_page = page_num + 1
            else:
                if current_ref is not None:
                    current_buf.append(stripped)

    flush()
    return out


def main(pdf_path: pathlib.Path) -> None:
    print(f"Reading: {pdf_path}")
    pdf_sha = _sha256(pdf_path)
    print(f"SHA256:  {pdf_sha}")

    with pdfplumber.open(pdf_path) as pdf:
        au_rows, region_rows = _extract_allocations(pdf)
        au_fns = _extract_footnotes(pdf, AU_FOOTNOTE_PAGES, is_australian=True)
        intl_fns = _extract_footnotes(pdf, INTL_FOOTNOTE_PAGES, is_australian=False)

    doc = {
        "meta": {
            "generation": 2,
            "source": {
                "title": "Australian Radiofrequency Spectrum Plan 2021",
                "subtitle": "Including general information",
                "url": "https://www.acma.gov.au/sites/default/files/2021-07/Australian%20Radiofrequency%20Spectrum%20Plan%202021_Including%20general%20information.pdf",
                "pdf_sha256": pdf_sha,
                "pdf_published": "2021-07",
            },
            "extracted_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "extractor_version": EXTRACTOR_VERSION,
        },
        "au_allocations": au_rows,
        "region_allocations": region_rows,
        "au_footnotes": au_fns,
        "intl_footnotes": intl_fns,
    }

    OUTPUT_YAML.parent.mkdir(parents=True, exist_ok=True)
    yaml = YAML(typ="rt")
    yaml.width = 4096
    yaml.default_flow_style = False
    with OUTPUT_YAML.open("w") as f:
        yaml.dump(doc, f)

    print(f"\nWrote {OUTPUT_YAML}")
    print(f"  au_allocations:     {len(au_rows)}")
    print(f"  region_allocations: {len(region_rows)}")
    print(f"  au_footnotes:       {len(au_fns)}")
    print(f"  intl_footnotes:     {len(intl_fns)}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python extract.py <path/to/pdf>", file=sys.stderr)
        sys.exit(1)
    main(pathlib.Path(sys.argv[1]))
