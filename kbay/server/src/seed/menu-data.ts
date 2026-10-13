// Pre-seeded catalogue. Everything here is editable in the app; prices are starting points
// for K-BAY in Islamabad (PKR) and recipe amounts are estimates until the one-time calibration
// study replaces them. Only the fries the stall sells today are switched on.

export interface SeedVariant {
  name: string;
  price: number; // rupees
  tag?: string;
  enabled?: boolean;
  openPrice?: { basis: number };
}

export interface SeedItem {
  name: string;
  description?: string;
  image: string;
  enabled?: boolean;
  variants: SeedVariant[];
  modifiers?: string[]; // modifier group names
  recipe?: 'plain_fries' | 'masala_fries' | 'cheesy_fries' | 'pizza_fries' | 'loaded_fries' | 'garlic_mayo_fries' | 'can' | 'bottle';
  deal?: { variant: string; components: { item: string; variant: string; qty: number }[] }[];
}

export interface SeedCategory {
  name: string;
  kind: 'food' | 'beverage';
  items: SeedItem[];
}

const SIZE_TAGS: Record<number, string> = { 50: 'Small', 100: 'Medium', 150: 'Large', 200: 'Extra large', 250: 'Double XL', 300: 'Triple XL' };

/** Plate sizes Rs 50-500 (from the calibration plan) plus a custom amount. 50-200 sell today. */
export function plateSizes(): SeedVariant[] {
  const out: SeedVariant[] = [];
  for (let p = 50; p <= 500; p += 50) out.push({ name: `Rs ${p}`, price: p, tag: SIZE_TAGS[p], enabled: p <= 200 });
  out.push({ name: 'Custom amount', price: 0, openPrice: { basis: 100 }, enabled: true });
  return out;
}

const sml = (s: number, m: number, l: number): SeedVariant[] => [
  { name: 'Small', price: s, tag: 'Small' },
  { name: 'Medium', price: m, tag: 'Medium' },
  { name: 'Large', price: l, tag: 'Large' },
];

export const MENU: SeedCategory[] = [
  {
    name: 'Fries', kind: 'food', items: [
      { name: 'Salted Fries', description: 'Classic golden fries, lightly salted.', image: '/menu/fries.svg', enabled: true,
        variants: plateSizes(), modifiers: ['Sauces', 'Extras'], recipe: 'plain_fries' },
      { name: 'Masala Fries', description: 'Fries tossed in K-BAY masala.', image: '/menu/masala-fries.svg', enabled: true,
        variants: plateSizes(), modifiers: ['Sauces', 'Extras'], recipe: 'masala_fries' },
      { name: 'Butterfly Fries', description: 'Wide-cut butterfly fries.', image: '/menu/fries.svg', variants: sml(150, 250, 350), modifiers: ['Sauces', 'Extras'] },
      { name: 'Curly Fries', description: 'Seasoned spiral fries.', image: '/menu/fries.svg', variants: sml(200, 300, 400), modifiers: ['Sauces', 'Extras'] },
      { name: 'Potato Wedges', description: 'Thick skin-on wedges.', image: '/menu/wedges.svg', variants: sml(200, 300, 400), modifiers: ['Sauces', 'Extras'] },
      { name: 'Peri Peri Fries', description: 'Fries with peri peri seasoning.', image: '/menu/masala-fries.svg', variants: sml(150, 250, 350), modifiers: ['Sauces', 'Extras'] },
    ],
  },
  {
    name: 'Loaded Fries', kind: 'food', items: [
      { name: 'Cheesy Fries', description: 'Fries under warm cheese sauce.', image: '/menu/loaded-fries.svg', variants: sml(250, 350, 450), modifiers: ['Extras'], recipe: 'cheesy_fries' },
      { name: 'Pizza Fries', description: 'Pizza sauce, mozzarella and chicken over fries.', image: '/menu/pizza-fries.svg', variants: sml(350, 450, 600), modifiers: ['Extras'], recipe: 'pizza_fries' },
      { name: 'Loaded Chicken Fries', description: 'Fries, crispy chicken, cheese and sauces.', image: '/menu/loaded-fries.svg', variants: sml(400, 550, 700), modifiers: ['Extras'], recipe: 'loaded_fries' },
      { name: 'Garlic Mayo Fries', description: 'Fries with garlic mayo drizzle.', image: '/menu/loaded-fries.svg', variants: sml(200, 300, 400), modifiers: ['Extras'], recipe: 'garlic_mayo_fries' },
    ],
  },
  {
    name: 'Burgers', kind: 'food', items: [
      { name: 'Zinger Burger', description: 'Crispy fried chicken fillet, lettuce, mayo.', image: '/menu/burger.svg', variants: [{ name: 'Regular', price: 450 }, { name: 'Large', price: 600 }], modifiers: ['Burger extras'] },
      { name: 'Chicken Burger', image: '/menu/burger.svg', variants: [{ name: 'Regular', price: 350 }] , modifiers: ['Burger extras'] },
      { name: 'Beef Burger', image: '/menu/burger.svg', variants: [{ name: 'Regular', price: 550 }], modifiers: ['Burger extras'] },
      { name: 'Patty Burger', image: '/menu/burger.svg', variants: [{ name: 'Regular', price: 250 }], modifiers: ['Burger extras'] },
      { name: 'Tower Burger', image: '/menu/burger.svg', variants: [{ name: 'Regular', price: 750 }], modifiers: ['Burger extras'] },
    ],
  },
  {
    name: 'Wraps & Rolls', kind: 'food', items: [
      { name: 'Chicken Shawarma', image: '/menu/wrap.svg', variants: [{ name: 'Regular', price: 250 }, { name: 'Large', price: 350 }] },
      { name: 'Zinger Paratha Roll', image: '/menu/wrap.svg', variants: [{ name: 'Regular', price: 350 }] },
      { name: 'Chicken Wrap', image: '/menu/wrap.svg', variants: [{ name: 'Regular', price: 400 }] },
    ],
  },
  {
    name: 'Fried Chicken', kind: 'food', items: [
      { name: 'Chicken Broast', image: '/menu/chicken.svg', variants: [{ name: 'Quarter', price: 550 }, { name: 'Half', price: 950 }, { name: 'Full', price: 1800 }] },
      { name: 'Hot Wings', image: '/menu/chicken.svg', variants: [{ name: '6 pieces', price: 450 }, { name: '12 pieces', price: 850 }] },
      { name: 'Chicken Nuggets', image: '/menu/chicken.svg', variants: [{ name: '6 pieces', price: 350 }, { name: '10 pieces', price: 550 }] },
    ],
  },
  {
    name: 'Sides & Snacks', kind: 'food', items: [
      { name: 'Hot Dog', image: '/menu/sides.svg', variants: [{ name: 'Regular', price: 250 }] },
      { name: 'Club Sandwich', image: '/menu/sides.svg', variants: [{ name: 'Regular', price: 450 }] },
      { name: 'Coleslaw', image: '/menu/sides.svg', variants: [{ name: 'Cup', price: 100 }] },
    ],
  },
  {
    name: 'Beverages', kind: 'beverage', items: [
      { name: 'Soft Drink', description: 'Coke, Pepsi, Sprite, 7Up, Fanta...', image: '/menu/drink.svg', recipe: 'bottle',
        variants: [{ name: 'Can', price: 120 }, { name: '250ml', price: 70 }, { name: '350ml', price: 100 }, { name: '500ml', price: 150 }, { name: '1.5 litre', price: 250 }] },
      { name: 'Mineral Water', image: '/menu/water.svg', variants: [{ name: '500ml', price: 60 }, { name: '1.5 litre', price: 120 }] },
      { name: 'Fresh Lime', image: '/menu/drink.svg', variants: [{ name: 'Glass', price: 150 }] },
      { name: 'Mint Margarita', image: '/menu/drink.svg', variants: [{ name: 'Glass', price: 250 }] },
      { name: 'Doodh Patti Chai', image: '/menu/chai.svg', variants: [{ name: 'Cup', price: 80 }] },
      { name: 'Lassi', image: '/menu/drink.svg', variants: [{ name: 'Glass', price: 150 }] },
    ],
  },
  {
    name: 'Deals', kind: 'food', items: [
      { name: 'Fries & Drink Deal', description: 'Rs 100 salted fries with a 350ml soft drink.', image: '/menu/deal.svg',
        variants: [{ name: 'Deal', price: 180 }],
        deal: [{ variant: 'Deal', components: [{ item: 'Salted Fries', variant: 'Rs 100', qty: 1 }, { item: 'Soft Drink', variant: '350ml', qty: 1 }] }] },
      { name: 'Zinger Meal', description: 'Zinger burger, Rs 100 fries and a 350ml drink.', image: '/menu/deal.svg',
        variants: [{ name: 'Meal', price: 650 }],
        deal: [{ variant: 'Meal', components: [{ item: 'Zinger Burger', variant: 'Regular', qty: 1 }, { item: 'Salted Fries', variant: 'Rs 100', qty: 1 },
          { item: 'Soft Drink', variant: '350ml', qty: 1 }] }] },
      { name: 'Family Fries Bucket', description: 'Two Rs 200 salted fries and two Rs 200 masala fries.', image: '/menu/deal.svg',
        variants: [{ name: 'Bucket', price: 750 }],
        deal: [{ variant: 'Bucket', components: [{ item: 'Salted Fries', variant: 'Rs 200', qty: 2 }, { item: 'Masala Fries', variant: 'Rs 200', qty: 2 }] }] },
    ],
  },
];

export const MODIFIER_GROUPS = [
  { name: 'Sauces', min: 0, max: 3, modifiers: [{ name: 'Ketchup', price: 0 }, { name: 'Mayo', price: 0 }, { name: 'Chilli garlic', price: 0 }] },
  { name: 'Extras', min: 0, max: 4, modifiers: [{ name: 'Extra masala', price: 20 }, { name: 'Extra mayo', price: 30 }, { name: 'Cheese sauce', price: 80 },
    { name: 'Extra ketchup sachet', price: 10 }] },
  { name: 'Burger extras', min: 0, max: 3, modifiers: [{ name: 'Extra cheese slice', price: 60 }, { name: 'Extra patty', price: 200 }, { name: 'Jalapenos', price: 40 }] },
];
