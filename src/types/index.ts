export interface Product {
  id: string;
  user_id: string;
  name: string;
  sku: string | null;
  price_buy: number;
  price_sell: number;
  stock_qty: number;
  min_stock_level: number;
  category: string | null;
  created_at: string;
  updated_at: string;
}

export interface Sale {
  id: string;
  user_id: string;
  total_amount: number;
  payment_method: 'cash' | 'momo';
  note: string | null;
  created_at: string;
}

export interface SaleItem {
  id: string;
  sale_id: string;
  product_id: string;
  product_name: string;
  quantity: number;
  unit_price: number;
  subtotal: number;
}

export interface StockLog {
  id: string;
  user_id: string;
  product_id: string;
  product_name: string;
  movement_type: 'sale' | 'restock' | 'adjustment';
  quantity_change: number;
  stock_before: number;
  stock_after: number;
  reference_id: string | null;
  created_at: string;
}

// Panier POS
export interface CartItem {
  product: Product;
  quantity: number;
}
