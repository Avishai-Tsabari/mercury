# Drive Reference

Use `gws drive` for all Google Drive operations.

## List files in root (My Drive)

```bash
gws drive files list --params '{"pageSize":20}'
```

Response fields to use: `name`, `mimeType`, `modifiedTime`. Never show `id` to the user — keep it for follow-up commands.

## List files in a specific folder

First get the folder ID from a `files list` call (store internally):

```bash
# Find folder by name
gws drive files list --params '{"q":"name = '\''Reports'\'' and mimeType = '\''application/vnd.google-apps.folder'\''","pageSize":5}'

# List files inside the folder
gws drive files list --params '{"q":"'\''<FOLDER_ID>'\'' in parents","pageSize":20}'
```

## Search by name

```bash
gws drive files list --params '{"q":"name contains '\''budget'\''","pageSize":10}'
```

## Upload a file

```bash
# Upload to root
gws drive +upload ./report.pdf

# Upload to a specific folder
gws drive +upload ./report.pdf --parent <FOLDER_ID>

# Upload with a custom name
gws drive +upload ./data.csv --name 'Sales Data Q1.csv'
```

## Create a folder

```bash
gws drive files create --json '{"name":"New Folder","mimeType":"application/vnd.google-apps.folder"}'

# Inside an existing folder
gws drive files create --json '{"name":"Sub Folder","mimeType":"application/vnd.google-apps.folder","parents":["<PARENT_FOLDER_ID>"]}'
```

## Move a file to a folder

```bash
gws drive files update --params '{"fileId":"<FILE_ID>","addParents":"<FOLDER_ID>","removeParents":"root"}'
```

## Download a file

```bash
gws drive files download --params '{"fileId":"<FILE_ID>"}' --output ./downloaded-file.pdf

# Export a Google Doc as plain text
gws drive files export --params '{"fileId":"<DOC_ID>","mimeType":"text/plain"}' --output ./doc.txt
```

## Raw API fallback

```bash
gws drive files --help   # list all files subcommands
```

## Output format rules

- List files as: "1. Budget 2026 (Google Sheets) — modified 3 days ago"
- Translate MIME types: `application/vnd.google-apps.document` → "Google Doc", `application/vnd.google-apps.spreadsheet` → "spreadsheet", `application/vnd.google-apps.folder` → "folder", `application/pdf` → "PDF"
- Never show `fileId`, `parents`, or any other ID field
- Upload confirmation: "Uploaded report.pdf to your Drive" (or "to the Reports folder" if parent specified)
