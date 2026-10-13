// Public API of the inventory module.
export {
  onOrderCompleted, onOrderVoided, receiveStock, listItems, upsertItem, setMixComponents, setVariety, listVarieties, getRecipe, setRecipe,
  plateCosts, stockLevels, recordWaste, listMovements, createStockRequest, listStockRequests, closeStockRequest, postCount, listCounts,
} from './service.js';
