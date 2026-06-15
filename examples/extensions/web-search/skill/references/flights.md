# Flights Reference

## Primary site: Google Flights

**Why Google Flights:**
- Deep-link URL accepts all search parameters (origin, destination, dates, passengers, cabin class, stops) — minimal or zero form interaction needed
- Clean accessibility tree: price cells have descriptive `aria-label` values (airline, price, duration, stops)
- No CAPTCHA for read-only searches
- Authoritative real-time pricing from airlines

**Fallback: Skyscanner** — use if Google Flights is inaccessible or returns no results. URL pattern below.

---

## URL Construction

### Round trip

```
https://www.google.com/travel/flights#flt={FROM}.{TO}.{DEPART_DATE}*{TO}.{FROM}.{RETURN_DATE};c:{CURRENCY};e:{STOPS};px:{PASSENGERS};t:f;tt:r
```

| Placeholder | Format | Example |
|---|---|---|
| `{FROM}` | IATA airport code | `TLV` |
| `{TO}` | IATA airport code | `BKK` |
| `{DEPART_DATE}` | YYYY-MM-DD | `2026-11-01` |
| `{RETURN_DATE}` | YYYY-MM-DD | `2026-11-22` |
| `{CURRENCY}` | ISO 4217 | `USD` |
| `{STOPS}` | `0` = nonstop only, `1` = 1 stop max, `2` = any | `0` |
| `{PASSENGERS}` | see below | |

**Passenger encoding:**
- Adults only: `{n}` e.g. `2`
- With children (use age): `{adults},c{age}` for each child e.g. `2,c7,c3` = 2 adults + child age 7 + child age 3
- Infants on lap: append `,i{age}` (age 0 or 1)

**Worked example — TLV→BKK, Nov 2026, 2 adults + child 7 + child 3, nonstop, round trip:**
```
https://www.google.com/travel/flights#flt=TLV.BKK.2026-11-01*BKK.TLV.2026-11-22;c:USD;e:0;px:2,c7,c3;t:f;tt:r
```

### One way

Replace `tt:r` with `tt:o` and remove the return leg (`*{TO}.{FROM}.{RETURN_DATE}`):
```
https://www.google.com/travel/flights#flt=TLV.BKK.2026-11-01;c:USD;e:0;px:2;t:f;tt:o
```

### Cabin class

Append `;sc:{CLASS}` where `CLASS` is: `0`=any, `1`=economy, `2`=premium economy, `3`=business, `4`=first.
Default (omit) shows economy.

---

## Step-by-Step Workflow

```bash
# 1. Ensure browser is running
pinchtab_ensure || exit 1

# 2. Navigate to the constructed URL
pinchtab nav "https://www.google.com/travel/flights#flt=TLV.BKK.2026-11-01*BKK.TLV.2026-11-22;c:USD;e:0;px:2,c7,c3;t:f;tt:r"

# 3. Wait for page to render (Google Flights loads results asynchronously)
sleep 4

# 4. Extract text — check that flight results are present
pinchtab text
```

If `pinchtab text` returns flight results (airline names, prices, durations), extract the top 5–10 and format the reply. Done — no further interaction needed.

If results are not yet loaded (text shows only navigation/header): `sleep 3` and retry `pinchtab text` once.

---

## Filter Interaction (only if not pre-set in URL)

If the user wants a filter that cannot be encoded in the URL (e.g. specific airline preference, baggage included):

```bash
# Get interactive refs for filter controls
pinchtab snap -i -c

# Find the relevant filter ref (e.g. "Stops" dropdown, "Airlines" filter)
# Click it, wait 2 seconds, re-read text
pinchtab click {ref}
sleep 2
pinchtab text
```

---

## Result Extraction

From `pinchtab text` output, look for lines containing:
- Airline name (e.g. El Al, Thai Airways, Emirates)
- Departure and arrival times
- Duration (e.g. "11 hr 20 min")
- Stop count (e.g. "Nonstop", "1 stop")
- Price (e.g. "$1,240")

**Sort order**: Google Flights defaults to "Best" (mix of price + duration). If the user wants cheapest first, look for the sort control and click "Cheapest" via `snap -i -c`.

---

## Fallback: Skyscanner

Use if Google Flights is blocked or returns no results.

```
https://www.skyscanner.com/transport/flights/{from}/{to}/{YYMMDD_depart}/{YYMMDD_return}/?adults={n}&children={n}&childrensages={age1},{age2}&cabinclass=economy&stops=!oneOrMore&currency=USD
```

Date format for Skyscanner: `YYMMDD` (e.g. `261101` for 2026-11-01).

```bash
pinchtab nav "https://www.skyscanner.com/transport/flights/tlv/bkk/261101/261122/?adults=2&children=2&childrensages=7,3&cabinclass=economy&stops=!oneOrMore&currency=USD"
sleep 5   # Skyscanner loads slower than Google Flights
pinchtab text
```

**Known issue**: Skyscanner occasionally shows a cookie consent banner on first load. If `pinchtab text` shows no results, run `pinchtab snap -i -c`, find the "Accept" or "Continue" button ref, click it, then re-navigate.

---

## Token Efficiency

- **Always start with `pinchtab text`** (~800 tokens) — sufficient to read all flight results.
- Only use `pinchtab snap -i -c` (~3,600 tokens) if you need to click a filter.
- Never use full `pinchtab snap` for flight searches.
