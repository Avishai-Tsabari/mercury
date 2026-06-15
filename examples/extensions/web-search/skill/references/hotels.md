# Hotels Reference

## Primary site: Google Hotels

**Why Google Hotels:**
- Deep-link URL accepts city, dates, and guest counts
- Clean accessibility tree: hotel cards have price, rating, and neighbourhood in aria-labels
- No CAPTCHA for read-only searches
- Aggregates pricing across Booking.com, Expedia, Hotels.com, and direct hotel sites

**Fallback: Booking.com** — broader international coverage, especially for non-English cities. See below.

---

## URL Construction

```
https://www.google.com/travel/hotels/entity/{CITY_SLUG}?q=hotels+in+{CITY}&checkin={CHECKIN}&checkout={CHECKOUT}&adults={ADULTS}&children={CHILDREN_AGES}
```

The simplest and most reliable approach is the natural-language search URL:

```
https://www.google.com/travel/hotels?q=hotels+in+{CITY}&checkin={CHECKIN}&checkout={CHECKOUT}
```

| Placeholder | Format | Example |
|---|---|---|
| `{CITY}` | URL-encoded city name | `Bangkok` → `Bangkok` |
| `{CHECKIN}` | YYYY-MM-DD | `2026-11-01` |
| `{CHECKOUT}` | YYYY-MM-DD | `2026-11-08` |
| `{ADULTS}` | integer | `2` |
| `{CHILDREN_AGES}` | comma-separated ages | `7,3` |

**Worked example — Bangkok, 2 adults + child 7 + child 3, Nov 1–8:**
```
https://www.google.com/travel/hotels?q=hotels+in+Bangkok&checkin=2026-11-01&checkout=2026-11-08
```

Guest counts and filters are best applied after load via filter refs (see below).

---

## Step-by-Step Workflow

```bash
# 1. Ensure browser is running
pinchtab_ensure || exit 1

# 2. Navigate
pinchtab nav "https://www.google.com/travel/hotels?q=hotels+in+Bangkok&checkin=2026-11-01&checkout=2026-11-08"

# 3. Wait for results to render
sleep 4

# 4. Extract results
pinchtab text
```

If results are present (hotel names, prices, ratings), extract top 5–10. Done.

---

## Adjusting Guest Count

If the default guest count (2 adults) doesn't match the request:

```bash
pinchtab snap -i -c
# Find the "Travelers" or "Guests" selector ref
pinchtab click {ref}
sleep 2
pinchtab snap -i -c
# Find increment/decrement refs for adults and children
# Adjust, then close and re-read
pinchtab text
```

---

## Applying Filters

| Filter | What to look for in snap -i -c |
|---|---|
| Price range | "Price" filter button ref |
| Star rating | "Hotel class" filter button ref |
| Sort by price | "Sort" dropdown → "Price: low to high" option ref |
| Amenities | "Amenities" filter ref |

---

## Result Extraction

From `pinchtab text`, look for:
- Hotel name
- Nightly price (e.g. "$89/night")
- Total price for stay
- Star rating or guest score
- Neighbourhood / distance from centre

---

## Fallback: Booking.com

Use for cities where Google Hotels returns sparse results, or for more granular filtering.

```
https://www.booking.com/searchresults.html?ss={CITY}&checkin={CHECKIN}&checkout={CHECKOUT}&group_adults={ADULTS}&no_rooms=1&group_children={CHILDREN}&age={CHILD_AGE_1}&age={CHILD_AGE_2}
```

```bash
pinchtab nav "https://www.booking.com/searchresults.html?ss=Bangkok&checkin=2026-11-01&checkout=2026-11-08&group_adults=2&no_rooms=1&group_children=2&age=7&age=3"
sleep 4
pinchtab text
```

**Known issue — cookie consent banner**: Booking.com shows a GDPR consent dialog on first load. If `pinchtab text` returns no hotel results:

```bash
pinchtab snap -i -c
# Find the "Accept" or "I agree" button ref
pinchtab click {ref}
sleep 2
pinchtab text
```

---

## Fallback: Airbnb (for apartment-style or vacation rental framing)

Use when the user says "Airbnb", "vacation rental", or "apartment with kitchen":

```
https://www.airbnb.com/s/{CITY}/homes?checkin={CHECKIN}&checkout={CHECKOUT}&adults={ADULTS}&children={CHILDREN}
```

```bash
pinchtab nav "https://www.airbnb.com/s/Bangkok/homes?checkin=2026-11-01&checkout=2026-11-08&adults=2&children=2"
sleep 5   # Airbnb is React-heavy, needs extra time
pinchtab text
```

---

## Token Efficiency

- `pinchtab text` (~800 tokens) is sufficient to read hotel names, prices, and ratings.
- Use `pinchtab snap -i -c` only when adjusting guest counts or applying filters.
