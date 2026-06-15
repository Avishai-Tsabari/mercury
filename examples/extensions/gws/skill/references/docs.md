# Docs Reference

Use `gws docs` for reading and writing Google Docs.

## Read a document

First find the document ID from Drive:

```bash
# Find document by name
gws drive files list --params '{"q":"name contains '\''Meeting Notes'\'' and mimeType = '\''application/vnd.google-apps.document'\''","pageSize":5}'
```

Then export its content as plain text:

```bash
gws drive files export --params '{"fileId":"<DOC_ID>","mimeType":"text/plain"}' --output /tmp/doc.txt
cat /tmp/doc.txt
```

## Summarize a document

Read the document with the export method above, then summarize the content in plain language. Never paste the raw text export as-is — always translate into a concise summary.

## Append text to a document

```bash
gws docs +write --document <DOC_ID> --text 'New paragraph to append.'
```

Text is inserted at the end of the document body. For multiline content, use `$'...'` shell quoting:

```bash
gws docs +write --document <DOC_ID> --text $'Line one.\nLine two.'
```

## Read document metadata

```bash
gws docs documents get --params '{"documentId":"<DOC_ID>"}'
```

Useful fields: `title`, `body.content` (structured content). For plain reading, prefer the Drive export approach above.

## Raw API fallback

```bash
gws docs --help   # list all subcommands
gws docs documents --help
```

For rich formatting (headings, bold, tables), use the raw `documents.batchUpdate` API:

```bash
gws docs documents batchUpdate \
  --params '{"documentId":"<DOC_ID>"}' \
  --json '{"requests":[{"insertText":{"location":{"index":1},"text":"Hello\n"}}]}'
```

## Output format rules

- Document found: say "I found your doc — [title]"
- Summary: present as a plain paragraph or bullet list of key points
- Append confirmation: "Added your text to '[document title]'"
- Never show document IDs, revision IDs, or raw JSON content structures
