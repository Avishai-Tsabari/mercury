# Sheets Reference

Use `gws sheets` for reading and writing Google Sheets.

## Read values from a spreadsheet

First find the spreadsheet ID from Drive (store internally — never show to user):

```bash
# Find spreadsheet by name
gws drive files list --params '{"q":"name contains '\''Budget'\'' and mimeType = '\''application/vnd.google-apps.spreadsheet'\''","pageSize":5}'
```

Then read a range:

```bash
# Read a named range or A1 notation
gws sheets +read --spreadsheet <SPREADSHEET_ID> --range 'Sheet1!A1:D10'

# Read an entire sheet (by tab name)
gws sheets +read --spreadsheet <SPREADSHEET_ID> --range Sheet1
```

Present the data as a plain summary or a simple list — not as a raw JSON array.

## Append a row

```bash
# Simple comma-separated values (single row)
gws sheets +append --spreadsheet <SPREADSHEET_ID> --values 'Alice,100,true'

# Multiple rows (JSON array of arrays)
gws sheets +append --spreadsheet <SPREADSHEET_ID> \
  --json-values '[["Alice","100","true"],["Bob","200","false"]]'
```

Values are appended after the last row that contains data.

## Read all data and summarize

```bash
gws sheets +read --spreadsheet <SPREADSHEET_ID> --range Sheet1 --format table
```

Parse the table output to provide a plain-language summary (e.g. "The sheet has 42 rows. The highest value in column B is 250.").

## Raw API fallback

```bash
gws sheets spreadsheets get --params '{"spreadsheetId":"<SPREADSHEET_ID>"}'   # metadata + sheet names
gws sheets spreadsheets values get --params '{"spreadsheetId":"<SPREADSHEET_ID>","range":"Sheet1!A1:Z100"}'
gws sheets --help   # list all subcommands
```

## Output format rules

- Read results: present as a short prose summary or a simple list — never paste raw JSON arrays
- Append confirmation: "Added a row to '[spreadsheet name]'"
- Never show spreadsheet IDs, sheet GIDs, or raw cell object structures
- If the range is empty, say "That range appears to be empty"
