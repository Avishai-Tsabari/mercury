# Apartments Reference

## Branch: Short-Term vs Long-Term

**Always confirm before navigating:**
- **Short-term** = nightly rental (Airbnb-style, days/weeks, travel or vacation)
- **Long-term** = monthly lease or purchase (living, relocation)

---

## Short-Term: Airbnb (primary)

**Why**: Best accessibility tree for short-term rentals, reliable URL deep-linking, no consent banners.

### URL Construction

```
https://www.airbnb.com/s/{CITY}/homes?checkin={CHECKIN}&checkout={CHECKOUT}&adults={ADULTS}&children={CHILDREN}&min_bedrooms={BEDROOMS}&price_max={NIGHTLY_MAX}
```

| Placeholder | Format | Example |
|---|---|---|
| `{CITY}` | URL-encoded city | `Bangkok`, `Tel+Aviv` |
| `{CHECKIN}` | YYYY-MM-DD | `2026-11-01` |
| `{CHECKOUT}` | YYYY-MM-DD | `2026-11-22` |
| `{ADULTS}` | integer | `2` |
| `{CHILDREN}` | integer | `2` |
| `{BEDROOMS}` | integer | `2` |
| `{NIGHTLY_MAX}` | integer (USD) | `150` |

**Worked example — Bangkok, Nov 1–22, 2 adults + 2 children, 2+ bedrooms:**
```
https://www.airbnb.com/s/Bangkok/homes?checkin=2026-11-01&checkout=2026-11-22&adults=2&children=2&min_bedrooms=2
```

### Workflow

```bash
pinchtab_ensure || exit 1
pinchtab nav "https://www.airbnb.com/s/Bangkok/homes?checkin=2026-11-01&checkout=2026-11-22&adults=2&children=2&min_bedrooms=2"
sleep 5   # Airbnb is React-heavy — needs longer render time
pinchtab text
```

---

## Short-Term Fallback: Booking.com Apartments

Use when Airbnb results are sparse or user prefers hotel-apartment hybrids.

```
https://www.booking.com/searchresults.html?ss={CITY}&checkin={CHECKIN}&checkout={CHECKOUT}&group_adults={ADULTS}&group_children={CHILDREN}&age={AGE1}&age={AGE2}&nflt=ht_id%3D201%3Bht_id%3D220
```
(`ht_id=201` = apartments; `ht_id=220` = holiday homes — include both)

```bash
pinchtab nav "https://www.booking.com/searchresults.html?ss=Bangkok&checkin=2026-11-01&checkout=2026-11-22&group_adults=2&group_children=2&age=7&age=3&nflt=ht_id%3D201%3Bht_id%3D220"
sleep 4
pinchtab text
```

**Known issue — consent banner**: If `pinchtab text` shows no results, run `pinchtab snap -i -c`, find the "Accept" button ref, click it, wait 2s, then re-navigate.

---

## Long-Term: Site Selection by Region

| Region | Rent | Buy |
|---|---|---|
| Israel | Yad2 | Yad2 |
| UK | Rightmove | Rightmove |
| Spain / Italy / Portugal | Idealista | Idealista |
| France | SeLoger | SeLoger |
| USA | Zillow | Zillow |
| Germany | ImmoScout24 | ImmoScout24 |
| International | Airbnb (monthly) | — |

---

## Yad2 — Long-Term (Israel)

```
https://www.yad2.co.il/realestate/rent?city={CITY_ID}&rooms={MIN_ROOMS}-{MAX_ROOMS}&price={MIN}-{MAX}
```

For open search in Tel Aviv:
```
https://www.yad2.co.il/realestate/rent?topArea=2&area=1
```
(topArea=2, area=1 = Tel Aviv district)

```bash
pinchtab nav "https://www.yad2.co.il/realestate/rent?topArea=2&area=1"
sleep 4
pinchtab text
```

**Note**: Results are in Hebrew. Extract prices (numbers with ₪), room counts, and neighbourhood names.

---

## Rightmove — Long-Term (UK)

```
https://www.rightmove.co.uk/property-to-rent/find.html?searchType=RENT&locationIdentifier=REGION%5E{ID}&maxPrice={MAX}&minBedrooms={BEDS}
```

For a city-level search without a region ID, use the simpler form:
```
https://www.rightmove.co.uk/property-to-rent/find.html?searchType=RENT&searchLocation={CITY}&maxPrice={MAX_PCM}&minBedrooms={BEDS}
```

```bash
pinchtab nav "https://www.rightmove.co.uk/property-to-rent/find.html?searchType=RENT&searchLocation=London&maxPrice=2000&minBedrooms=2"
sleep 4
pinchtab text
```

---

## Zillow — Long-Term (USA)

```
https://www.zillow.com/homes/for_rent/{CITY}/?searchQueryState={"pagination":{},"mapBounds":{},"filterState":{"price":{"max":{MAX}},"beds":{"min":{BEDS}}}}
```

Simpler URL (Zillow also accepts natural-language city in the path):
```
https://www.zillow.com/homes/for_rent/New-York,-NY/
```

```bash
pinchtab nav "https://www.zillow.com/homes/for_rent/New-York,-NY/"
sleep 5   # Zillow is JS-heavy
pinchtab text
```

---

## Idealista — Long-Term (Spain, Italy, Portugal)

```
https://www.idealista.com/en/alquiler-viviendas/{CITY_SLUG}-{PROVINCE}/con-{ROOMS}-habitaciones,precio-hasta-{MAX}/
```

**Known issue**: Idealista occasionally shows an anti-bot challenge on first load. If `pinchtab text` shows a Cloudflare page:
1. Wait 10 seconds: `sleep 10`
2. Retry `pinchtab text`
3. If still blocked, try Airbnb monthly as fallback

---

## Airbnb Monthly (International Long-Term Fallback)

Airbnb supports monthly stays with discounted rates. Use as a universal long-term fallback:

```
https://www.airbnb.com/s/{CITY}/homes?checkin={START}&checkout={END}&adults={ADULTS}&children={CHILDREN}&min_bedrooms={BEDS}&monthly_length=1
```

---

## Result Extraction

From `pinchtab text`, extract per listing:
- Property description (studio, 1BR, 2BR, house, etc.)
- Price (per night for short-term; per month for long-term; or asking price for purchase)
- Location / neighbourhood
- Key amenities if visible (pool, parking, A/C)
- Link or listing ID if visible

---

## Token Efficiency

- `pinchtab text` is sufficient to read listing summaries.
- Use `pinchtab snap -i -c` only for interacting with price/bedroom filters.
- Airbnb and Booking load slower than Google products — always use `sleep 5` minimum.
