# Gmail Reference

Use `gws gmail` for all email operations. All helpers are read-only except `+send`, `+reply`, `+reply-all`, and `+forward`.

## Triage inbox

```bash
# Show unread messages (default: 20)
gws gmail +triage

# Limit count or filter by search query
gws gmail +triage --max 10
gws gmail +triage --query 'from:boss@example.com'
gws gmail +triage --query 'is:unread subject:invoice'
```

Output fields: sender, subject, date. Never show `messageId`, `threadId`, or `labelIds`.

## Read a message

First get the message ID from `+triage` output (use internally only — never show it to the user).

```bash
gws gmail +read --id <MESSAGE_ID>
gws gmail +read --id <MESSAGE_ID> --headers    # includes From, To, Subject, Date
```

Present: sender name, subject, date, and a plain-text summary of the body.

## Send a new email

```bash
gws gmail +send --to alice@example.com --subject 'Hello' --body 'Hi Alice!'

# With CC / BCC
gws gmail +send --to alice@example.com --subject 'Report' --body 'See attached' \
  --cc bob@example.com --bcc charlie@example.com

# With attachment
gws gmail +send --to alice@example.com --subject 'Report' --body 'Attached.' -a report.pdf

# Save as draft first, then confirm with user before sending
gws gmail +send --to alice@example.com --subject 'Hello' --body 'Hi!' --draft
```

Always confirm recipient and subject with the user before sending.

## Reply to a message

```bash
gws gmail +reply --message-id <MESSAGE_ID> --body 'Thanks, got it!'

# Reply-all
gws gmail +reply-all --message-id <MESSAGE_ID> --body 'Noted — will follow up.'
```

Handles threading (In-Reply-To, References) automatically.

## Forward a message

```bash
gws gmail +forward --message-id <MESSAGE_ID> --to dave@example.com
gws gmail +forward --message-id <MESSAGE_ID> --to dave@example.com --body 'FYI see below'
```

## Raw API fallback

```bash
# List messages with custom query
gws gmail users messages list --params '{"userId":"me","q":"is:unread","maxResults":10}'

# Get message metadata
gws gmail users messages get --params '{"userId":"me","id":"<MESSAGE_ID>","format":"metadata"}'

# Modify labels (e.g. archive = remove INBOX label)
gws gmail users messages modify --params '{"userId":"me","id":"<MESSAGE_ID>"}' \
  --json '{"removeLabelIds":["INBOX"]}'
```

## Output format rules

- Show sender name and subject; never show `messageId`, `threadId`, or `labelIds`
- Present a triage summary as a numbered list: "1. From Alice — Re: Invoice (2 hours ago)"
- For send/reply confirmations: "Sent to Alice — subject: Hello"
- Errors: say "I couldn't send the email" — never show HTTP status codes or API error objects
