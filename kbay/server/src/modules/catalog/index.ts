// Public API of the catalog (menu engine) module.
export {
  menu, priceLines, enabledTaxes, upsertCategory, upsertItem, setItemEnabled, setLocationItem, upsertVariant,
  setDealComponents, upsertModifierGroup, listTaxes, upsertTax, variantInfo, dealComponents,
  type PriceRequestLine, type PricedLine,
} from './service.js';
