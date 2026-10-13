# The formulas

Every number in K-BAY comes from these definitions. Each one is covered by an automated test
(`server/test`). Money is stored as whole paisa; quantities as thousandths of a gram, millilitre
or unit. No floating point is used for a stored number.

| Number | Formula | Where |
| --- | --- | --- |
| Line total | unit price (size price, or the custom amount) + option prices, × count | `orders/service.ts` |
| Tax added on top | subtotal × rate, rounded to the paisa | `computeTotals` |
| Tax inside the price | price − price × 10000 / (10000 + rate in bps) | `computeTotals` |
| Card / digital fee | applied only when the sale is paid into a non-cash account | `computeTotals` |
| Revenue booked | sale total − tax (tax goes to Tax payable) | `finance/sales.ts` |
| Ingredients used by a sale | recipe of the size × count (custom amount: × amount ÷ recipe basis) + option recipes; deals use their parts' recipes; a mix uses its parts in set proportions; "Potato" uses the variety in use at the stall | `inventory/stock.ts` |
| Cost of what was used | stock value × used ÷ stock quantity (moving average); if stock is zero or negative, the last purchase price | `applyMovement` |
| Average cost | stock value ÷ stock quantity, per stall and item | `stock_levels` |
| Purchase | adds quantity and its exact price to stock | `receiveStock` |
| Weekly count difference | counted − expected; valued at average cost; shortage is a cost, surplus reduces cost. Expected is kept next to counted forever | `postCount` |
| Profit | revenue − every expense head (cost of food, waste, wages, commission, rent, cash short…) | ledger |
| Theoretical plate cost | recipe × current average cost of each ingredient | `plateCosts` |
| Actual plate profit | sales of that size − ingredient cost actually drawn for those sales | `plateProfit` |
| Commission | person's % × sales they rang up that day (voids excluded), booked when the day is approved | `accrueCommission` |
| Wages | units (months/days/hours) × rate | `payWages` |
| Expected cash at close | everything the books say is in the drawer: float + cash sales − cash paid out ± transfers | `expectedAtClose` |
| Cash over / short | counted − expected, booked so the books match the drawer | `approveClose` |
| Partner share | each day's profit split by the shares in force that day; parts always add back to the exact total (largest remainder) | `allocate`, `earnedByPerson` |
| Still in the business (retained) | all-time earned − withdrawn − reinvested | `partnerStatement` |
| Loan outstanding | principal − converted to investment − refunds confirmed by the lender | `loanPosition` |

Every money event is a balanced double-entry journal entry. The database refuses an entry whose
debits and credits differ, refuses any edit to a posted entry (corrections are new entries), and
refuses new entries on a day that has been approved and locked.
