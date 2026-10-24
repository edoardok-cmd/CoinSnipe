/** Source adapters and the asset universe (CSN-020). More adapters arrive with CSN-021 onward. */
export const DATA_PACKAGE = '@coinsnipe/data' as const;

export * from './universe/buildUniverse';
export * from './universe/sectorMap';
export * from './universe/sources';
