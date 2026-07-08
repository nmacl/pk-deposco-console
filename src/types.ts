// BC source records (only the fields we use — BC returns many more)

export interface BcItemCard {
  No: string;
  Description?: string;
  Base_Unit_of_Measure?: string;
  Brand?: string;
  Style?: string;
  Unit_Price?: number;
  Unit_Cost?: number;
  Last_Direct_Cost?: number;
  Blocked?: boolean;
  Sales_Blocked?: boolean;
  Type?: string;
  Last_Date_Modified?: string;
}

export interface BcItemVariant {
  Item_No: string;
  Code: string;
  Description?: string;
  Description_2?: string;
  Block?: boolean;
  Brand?: string;
  WebshopVariantCode?: string;
  Size?: string;
  UPC_GTN_No?: string;
}

export interface OdataPage<T> {
  value: T[];
  '@odata.nextLink'?: string;
}

// Deposco payload shape — matches the validated reference exactly

export interface DeposcoBusinessKey {
  code?: string;
  name?: string;
}

export interface DeposcoBusinessUnit {
  businessKey: DeposcoBusinessKey;
}

export interface DeposcoWeight {
  weight: number;
  units: 'lb';
}

export interface DeposcoMeasurement {
  measurement: number;
  units: 'in';
}

export interface DeposcoDimensions {
  length: DeposcoMeasurement;
  width: DeposcoMeasurement;
  height: DeposcoMeasurement;
}

export interface DeposcoPack {
  type: 'Each';
  quantity: 1;
  newPackFlag: boolean;
  weight: DeposcoWeight;
  dimensions: DeposcoDimensions;
}

export interface DeposcoChannel {
  integration: { businessKey: { name: string } };
  listingStatus: 'Linked';
  saleable: boolean;
  packQuantity: 1;
  ref1: string;
  ref2: string;
  ref3: 'EA';
  ref4: string;
}

export interface DeposcoItem {
  number: string;
  businessUnit: DeposcoBusinessUnit;
  name: string;
  shortDescription: string;
  longDescription: string;
  active: boolean;
  salesEnabledFlag: boolean;
  shippable: true;
  hazmat: false;
  inventoryTrackingEnabled: true;
  unitPrice: number;
  purchaseCost: number;
  packs: DeposcoPack[];
  upcs?: { data: Array<{ value: string }> };
  channels: DeposcoChannel[];
}
