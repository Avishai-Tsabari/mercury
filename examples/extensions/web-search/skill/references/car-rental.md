# Car Rental Reference

## Primary site: Kayak Cars

**Why Kayak Cars:**
- Aggregates multiple rental providers (Hertz, Avis, Enterprise, local agencies) in one search
- IATA airport codes work as pickup/dropoff locations — clean URL deep-linking
- Price cells labelled with provider name + car category + daily and total rate
- No login required for searching

**Fallback: Rentalcars.com** — better international coverage outside major airports. See below.

---

## URL Construction

```
https://www.kayak.com/cars/{LOCATION}/{PICKUP_DATE}-{PICKUP_TIME}h/{DROPOFF_DATE}-{DROPOFF_TIME}h
```

| Placeholder | Format | Example |
|---|---|---|
| `{LOCATION}` | IATA airport code or city name | `TLV` or `Bangkok` |
| `{PICKUP_DATE}` | YYYY-MM-DD | `2026-11-01` |
| `{PICKUP_TIME}` | HH (24h) | `10` |
| `{DROPOFF_DATE}` | YYYY-MM-DD | `2026-11-15` |
| `{DROPOFF_TIME}` | HH (24h) | `10` |

**Worked example — Bangkok airport, Nov 1–15, pickup/dropoff at 10:00:**
```
https://www.kayak.com/cars/BKK/2026-11-01-10h/2026-11-15-10h
```

---

## Step-by-Step Workflow

```bash
# 1. Ensure browser is running
pinchtab_ensure || exit 1

# 2. Navigate
pinchtab nav "https://www.kayak.com/cars/BKK/2026-11-01-10h/2026-11-15-10h"

# 3. Kayak loads results asynchronously — wait longer than usual
sleep 5

# 4. Extract results
pinchtab text
```

If `pinchtab text` returns car listings (provider names, car categories, prices), extract top 5–10.

If results are still loading (spinner text or empty): wait another 3 seconds and retry `pinchtab text` once.

---

## Applying Filters

| Filter | Action |
|---|---|
| Car category (economy, SUV, etc.) | Use `pinchtab snap -i -c`, find the category filter tabs at top, click the desired one |
| Sort by price | Kayak defaults to "Recommended" — find the sort dropdown ref, select "Price: lowest" |
| Specific provider | Find provider filter checkboxes in the left panel refs |

```bash
pinchtab snap -i -c
pinchtab click {sort-ref}
sleep 2
pinchtab text
```

---

## Result Extraction

From `pinchtab text`, look for:
- Rental provider (e.g. "Hertz", "Avis", "Sixt")
- Car category (e.g. "Economy", "Compact SUV")
- Representative car model (e.g. "Toyota Yaris or similar")
- Daily rate (e.g. "$28/day")
- Total price for period

---

## Under-25 Driver Note

Most rental providers charge a Young Driver Surcharge for drivers under 25. This cannot be pre-applied via URL on Kayak. Always mention in your reply: *"If any driver is under 25, additional surcharges will apply at the counter — verify with the provider before booking."*

---

## Fallback: Rentalcars.com

Use for locations where Kayak returns no results (city centres, train stations, non-IATA locations).

```
https://www.rentalcars.com/SearchResults.do?country={COUNTRY_CODE}&pickUpLocName={CITY}&depDate={DD/MM/YYYY}&retDate={DD/MM/YYYY}&depTime=1000&retTime=1000
```

```bash
pinchtab nav "https://www.rentalcars.com/SearchResults.do?country=TH&pickUpLocName=Bangkok&depDate=01/11/2026&retDate=15/11/2026&depTime=1000&retTime=1000"
sleep 5
pinchtab text
```

**Note**: Rentalcars.com has a noisier accessibility tree. Use `pinchtab text` exclusively; avoid full snapshot.

---

## Token Efficiency

- `pinchtab text` is sufficient for reading car listings and prices.
- Use `pinchtab snap -i -c` only for filter/sort interactions.
