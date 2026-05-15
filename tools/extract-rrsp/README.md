# RRSP 2021 Extractor

Parses the Australian Radiofrequency Spectrum Plan 2021 (PDF) into
`seed/spectrum_plan_source.yaml`. This YAML is the canonical source for the
`spectrum_*` SQLite tables; the SQL seed is generated from it.

## Source PDF

- URL: <https://www.acma.gov.au/sites/default/files/2021-07/Australian%20Radiofrequency%20Spectrum%20Plan%202021_Including%20general%20information.pdf>
- SHA256: `074e71a752eaa86ffaca002401849baf5018dc07647330a6f4d5796321375aa4`
- The PDF is not committed to this repository. Download it locally before running.

## Run

```bash
cd tools/extract-rrsp
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

python extract.py /path/to/Australian\ Radiofrequency\ Spectrum\ Plan\ 2021_Including\ general\ information.pdf
# Writes ../../seed/spectrum_plan_source.yaml

python audit.py ../../seed/spectrum_plan_source.yaml
# Prints any allocation cells whose `raw` field still contains un-decomposed line-soup.
```

## Tests

```bash
pytest tests/ -v
```
