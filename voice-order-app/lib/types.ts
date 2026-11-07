export type OrderItem = {
  name: string;
  quantity: number;
  notes?: string;
};

export type Order = {
  id: string;
  table: number;
  items: OrderItem[];
  transcript: string;
  createdAt: number;
  status: "open" | "served";
};
