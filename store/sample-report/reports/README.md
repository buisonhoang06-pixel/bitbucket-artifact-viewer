# Test run notes · demo-shop

Pipeline **#42** on `main`, 12 Nov 2026. See the [summary](summary.html) for every suite.

## What failed

| Suite | Case | Why |
|---|---|---|
| payments | refunds a partial amount | the refund total was rounded twice |
| payments | rounds NZD amounts to cents | `toFixed` cut instead of rounding |

## How to reproduce

```sh
npm ci
npm test -- --suite payments
```

> Both failures come from the same change to the currency helper.

## Next steps

1. Round once, in the currency helper
2. Add a case for partial refunds in NZD
   - with a 3-digit amount
   - with a zero amount
