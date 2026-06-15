# Calendar Reference

Use `gws calendar` for all calendar operations.

## Today's agenda

```bash
gws calendar +agenda --today
```

## This week's agenda

```bash
gws calendar +agenda --week
```

## Next N days

```bash
gws calendar +agenda --days 3
```

## Filter to a specific calendar

```bash
gws calendar +agenda --today --calendar 'Work'
gws calendar +agenda --week --calendar 'Personal'
```

## Timezone override

```bash
gws calendar +agenda --today --timezone America/New_York
```

## Create an event

```bash
gws calendar +insert \
  --summary 'Team Standup' \
  --start '2026-04-24T09:00:00-05:00' \
  --end '2026-04-24T09:30:00-05:00'

# With location and attendees
gws calendar +insert \
  --summary 'Project Review' \
  --start '2026-04-24T14:00:00-05:00' \
  --end '2026-04-24T15:00:00-05:00' \
  --location 'Conference Room A' \
  --attendee alice@example.com \
  --attendee bob@example.com

# With Google Meet link
gws calendar +insert \
  --summary 'Remote Sync' \
  --start '2026-04-24T10:00:00-05:00' \
  --end '2026-04-24T10:30:00-05:00' \
  --meet
```

Use RFC3339 format for times (e.g. `2026-04-24T09:00:00+03:00`). Always confirm date, time, and timezone with the user before creating.

## Reschedule an event

Get the event ID from `+agenda` output (store internally — never show to user):

```bash
# Get event ID
gws calendar events list --params '{"calendarId":"primary","q":"Team Standup","maxResults":5}'

# Update start/end times (replace timezone with the user's local timezone)
gws calendar events update \
  --params '{"calendarId":"primary","eventId":"<EVENT_ID>"}' \
  --json '{"start":{"dateTime":"2026-04-25T09:00:00-05:00","timeZone":"America/New_York"},"end":{"dateTime":"2026-04-25T09:30:00-05:00","timeZone":"America/New_York"}}'
```

## Meeting prep (attendees, agenda for an upcoming event)

```bash
# Find the event
gws calendar events list --params '{"calendarId":"primary","q":"<MEETING_NAME>","maxResults":3}'

# Get full event details including attendees
gws calendar events get --params '{"calendarId":"primary","eventId":"<EVENT_ID>"}'
```

Present: title, date/time, location (if any), attendee names — never show email addresses or event IDs unless the user asks.

## Raw API fallback

```bash
gws calendar events list --params '{"calendarId":"primary","timeMin":"<ISO_DATE>","maxResults":10}'
gws calendar --help   # list all subcommands
```

## Output format rules

- Agenda: "9:00 AM — Team Standup (30 min)" or "All day — Public Holiday"
- Event created: "Added 'Team Standup' to your calendar for Friday April 24 at 9:00 AM"
- Reschedule confirmation: "Moved 'Team Standup' to Saturday April 25 at 9:00 AM"
- Never show event IDs, calendar IDs, or raw dateTime strings
