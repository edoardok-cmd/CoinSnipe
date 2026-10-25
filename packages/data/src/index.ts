/** Source adapters and the asset universe (CSN-020). More adapters arrive with CSN-021 onward. */
export const DATA_PACKAGE = '@coinsnipe/data' as const;

export * from './universe/buildUniverse';
export * from './universe/sectorMap';
export * from './universe/sources';

// Macro and sentiment adapters (CSN-024). Master-plan IDs: A4, A6, A7, A8, A9, A10, D3.
export * from './sources/fred';
export * from './sources/feargreed';
export * from './sources/gpr';
export * from './sources/calendar';
