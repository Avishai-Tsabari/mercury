# Car Purchase Reference

## Site Selection by Region

The right site depends on the user's location. **Always ask or infer the country before navigating.**

| Region | Primary site | Fallback |
|---|---|---|
| Europe (excl. UK) | AutoScout24 | Mobile.de (Germany), LeBonCoin (France) |
| Israel | Yad2 | AutoScout24 |
| United Kingdom | AutoTrader UK | Gumtree |
| United States / Canada | CarGurus | Cars.com |
| Australia | CarsGuide | Drive.com.au |

---

## AutoScout24 (Europe — primary)

**Why**: Strong EU-wide inventory, clean URL filtering, accessible result cards with price, mileage, year.

### URL Construction

```
https://www.autoscout24.com/lst/{MAKE}/{MODEL}?atype=C&cy={COUNTRY_CODE}&pricefrom={MIN}&priceto={MAX}&kmfrom={MIN_KM}&kmto={MAX_KM}&fregfrom={YEAR_FROM}&fregto={YEAR_TO}&sort=price&desc=0
```

| Placeholder | Format / Values | Example |
|---|---|---|
| `{MAKE}` | lowercase make slug | `toyota`, `bmw`, `volkswagen` |
| `{MODEL}` | lowercase model slug | `corolla`, `3-series`, `golf` |
| `{COUNTRY_CODE}` | ISO 2-letter | `IL`, `DE`, `FR`, `IT`, `ES`, `NL` |
| `{MAX}` | integer (EUR) | `20000` |
| `{MAX_KM}` | integer | `150000` |
| `{YEAR_FROM}` | 4-digit year | `2018` |
| `sort=price&desc=0` | cheapest first | (keep as-is) |

**Worked example — used Toyota Corolla in Israel, under €20k, under 150k km, from 2018:**
```
https://www.autoscout24.com/lst/toyota/corolla?atype=C&cy=IL&priceto=20000&kmto=150000&fregfrom=2018&sort=price&desc=0
```

**Open search (no specific model):**
```
https://www.autoscout24.com/lst?atype=C&cy=IL&bodytype=3&priceto=20000&sort=price&desc=0
```
(`bodytype=3` = SUV; omit for any body type)

### Workflow

```bash
pinchtab_ensure || exit 1
pinchtab nav "https://www.autoscout24.com/lst/toyota/corolla?atype=C&cy=IL&priceto=20000&kmto=150000&fregfrom=2018&sort=price&desc=0"
sleep 4
pinchtab text
```

---

## Yad2 (Israel — primary for local listings)

**Why**: Dominant Israeli classifieds platform; more local dealer and private listings than AutoScout24 for Israel.

### URL Construction

```
https://www.yad2.co.il/vehicles/cars?manufacturer={MANUFACTURER_ID}&model={MODEL_ID}&price={MIN}-{MAX}&year={YEAR_FROM}-{YEAR_TO}&km={MIN_KM}-{MAX_KM}
```

Yad2 uses numeric IDs for manufacturer and model. For open search without a specific make:
```
https://www.yad2.co.il/vehicles/cars?price=0-100000&year=2018-2026
```

**Note**: Yad2 is in Hebrew. The `pinchtab text` output will be in Hebrew. Extract prices (numbers), years, and mileage numerically. Translate model names as needed.

### Workflow

```bash
pinchtab_ensure || exit 1
pinchtab nav "https://www.yad2.co.il/vehicles/cars?price=0-100000&year=2018-2026"
sleep 4
pinchtab text
```

---

## AutoTrader UK

```
https://www.autotrader.co.uk/car-search?make={MAKE}&model={MODEL}&price-to={MAX}&year-from={YEAR}&maximum-mileage={MAX_KM}&sort=price-asc
```

```bash
pinchtab nav "https://www.autotrader.co.uk/car-search?make=TOYOTA&model=COROLLA&price-to=20000&year-from=2018&maximum-mileage=100000&sort=price-asc"
sleep 4
pinchtab text
```

---

## CarGurus (USA / Canada)

```
https://www.cargurus.com/Cars/new/nl_New_Cars.d?zip={ZIP}&sortDir=ASC&sortType=PRICE&maxPrice={MAX}&minYear={YEAR}&makes[]={MAKE}
```

For used cars, use `nl_Used_Cars` instead of `nl_New_Cars`. Without a ZIP code, results show national listings.

```bash
pinchtab nav "https://www.cargurus.com/Cars/new/nl_Used_Cars.d?sortDir=ASC&sortType=PRICE&maxPrice=20000&minYear=2018&makes[]=Toyota"
sleep 4
pinchtab text
```

---

## Result Extraction

From `pinchtab text`, extract per listing:
- Make and model
- Year
- Mileage (km or miles)
- Price (and currency)
- Location (city or dealership name)
- Fuel type / transmission (if visible)

---

## Token Efficiency

- `pinchtab text` is sufficient for reading classified listings.
- Use `pinchtab snap -i -c` only if you need to interact with filters (e.g. adjust mileage slider, select body type).
