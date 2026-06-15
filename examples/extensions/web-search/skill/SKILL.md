---
name: web-search
description: Search public websites for real-world things — flights, hotels, car rentals, cars for purchase, and apartments/rentals. No credentials needed. Trigger when the user asks to find, compare, or book flights, accommodation, rental cars, used/new cars, or apartments. Uses headless browser automation (pinchtab) to navigate live sites and return real results.
---

# Web Search

Search public websites for travel, accommodation, vehicles, and real estate using the headless browser (pinchtab). No API keys or credentials required.

## Prerequisite

Before any search, ensure the browser is running:

```bash
pinchtab_ensure || exit 1
```

`pinchtab_ensure` is defined and injected by the pinchtab extension. If it is not already defined in your shell session, refer to the pinchtab skill for the full definition.

## Dispatch Table

Identify the search category from the user's intent, then read the corresponding reference file before proceeding.

| User intent keywords | Category | Reference file |
|---|---|---|
| flight, fly, airline, plane ticket | Flights | `references/flights.md` |
| hotel, hostel, stay, accommodation, resort, inn | Hotels | `references/hotels.md` |
| rent a car, car hire, rental car, hire car | Car rental | `references/car-rental.md` |
| buy a car, used car, new car, car for sale | Car purchase | `references/car-purchase.md` |
| apartment, flat, rent apartment, house for rent/sale, real estate | Apartments | `references/apartments.md` |

**Always read the reference file for the matched category before navigating.** It contains the site selection rationale, exact URL format, and step-by-step workflow.

## Parameter Collection

Do not navigate to any site until you have all required parameters. Ask the user for anything missing.

### Flights (required: origin, destination, departure date)
- Origin airport or city
- Destination airport or city
- Departure date
- Return date (ask if not given — confirm one-way only if explicitly stated)
- Passengers: number of adults; children with ages (ages affect pricing); infants
- Cabin class: economy / premium economy / business / first (default: economy)
- Nonstop only? (default: show all; apply filter if requested)
- Sort by: cheapest / fastest / best (default: cheapest)

### Hotels (required: city, check-in date, check-out date)
- City or area
- Check-in and check-out dates
- Number of adults and children (with ages if children)
- Number of rooms (default: 1)
- Star rating or price range (optional)
- Sort by: lowest price / rating / distance (default: lowest price)

### Car rental (required: pickup location, pickup date, dropoff date)
- Pickup location (city name or airport IATA code)
- Pickup date and time
- Dropoff date and time
- Same location dropoff? (if not, ask for dropoff location)
- Driver age (under-25 surcharges vary by provider)
- Car category preference: economy / compact / SUV / etc. (optional)

### Car purchase (required: make/model or open search, location/country)
- Make and/or model (or open description e.g. "any SUV")
- New or used
- Maximum price or price range
- Location / country (determines which site to use)
- Maximum mileage (for used cars)
- Year range (optional)

### Apartments (required: city, rent or buy, short-term or long-term)
- City or neighbourhood
- Rent or buy
- Short-term (nightly, like Airbnb) or long-term (monthly lease)?
- Price range (per night or per month)
- Number of bedrooms
- Move-in / available-from date

## Output Format

Present results as a numbered list. Limit to top 5–10 unless the user requests more.

```
1. [Airline / Hotel name / Car type / Listing title]
   Price: [amount + currency]
   Details: [duration + stops, or rating + location, or mileage + year, etc.]
   Dates: [if applicable]
   Link: [URL if visible in the page]

2. ...
```

Always state the site used and the search parameters at the top of the reply so the user can verify.

## Error Handling

- **CAPTCHA or bot block**: note it, try the fallback site listed in the reference file.
- **Empty results**: try relaxing one constraint (e.g. remove nonstop-only filter, expand dates ±1 day, widen price range). Inform the user what was relaxed.
- **Page timeout / snapshot failure**: retry once with an additional `sleep 5` before the snapshot. If it fails again, report the error and the last output.
- **Consent banner blocking content**: find the dismiss/accept button ref via `pinchtab snap -i -c` and click it, then re-navigate.
- **Max cycles**: do not loop more than 3 interaction cycles on a single page without reporting progress to the user.

## Token Efficiency

Match the pinchtab command to the task:

| Task | Command | ~Tokens |
|---|---|---|
| Read result prices/names | `pinchtab text` | ~800 |
| Find filter controls to click | `pinchtab snap -i -c` | ~3,600 |
| Full page understanding | `pinchtab snap` | ~10,500 |

Always start with `pinchtab text`. Only escalate to `snap -i -c` when you need to interact with a filter or button. Never use full `snap` for this skill.
