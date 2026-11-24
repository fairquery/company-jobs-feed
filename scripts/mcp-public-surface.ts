/**
 * Knip stand-in for the symbols mcp/src/index.ts imports from mcp/src/shared.
 * Those files are generated copies of src/ (mcp/scripts/sync-shared.mjs). A static
 * import here is a use of the canonical symbol, so knip does not treat an MCP-used
 * export as dead. scripts/check-mcp-surface.mjs fails if this list drifts.
 * The Actor and the MCP server do not load this module.
 */
import { detailUrl, fetchBoard, isValidSlug, listUrl, mapGreenhouse, mapLever } from '../src/ats.js';
import { discoverCompany, parseBoardUrl, seedLookup } from '../src/discovery.js';
import { compileFilters, matches } from '../src/filters.js';
import { AtsClient, CareersFetcher, HostGate, HttpError } from '../src/http.js';
import {
    COMPANIES_COMING_SOON_MESSAGE,
    INDEXED_SEARCH_PITCH,
    locationSearchNotice,
    scanSeedByLocation,
} from '../src/location-scan.js';
import { prettySlug } from '../src/normalize.js';
import { buildJobRow, jobFingerprint, type RowContext } from '../src/rows.js';
import { SEED_BOARDS } from '../src/seed.js';
import {
    type Ats,
    isValidGemVanity,
    isValidPersonioAccount,
    isValidPinpointSubdomain,
    type NormalizedJob,
} from '../src/types.js';

export type McpSharedSurfaceTypes = RowContext | Ats | NormalizedJob;

/** Referenced so the value imports stay live for knip. */
export const mcpSharedSurface = {
    detailUrl,
    fetchBoard,
    isValidSlug,
    listUrl,
    mapGreenhouse,
    mapLever,
    discoverCompany,
    parseBoardUrl,
    seedLookup,
    compileFilters,
    matches,
    AtsClient,
    CareersFetcher,
    HostGate,
    HttpError,
    COMPANIES_COMING_SOON_MESSAGE,
    INDEXED_SEARCH_PITCH,
    locationSearchNotice,
    scanSeedByLocation,
    prettySlug,
    buildJobRow,
    jobFingerprint,
    SEED_BOARDS,
    isValidGemVanity,
    isValidPersonioAccount,
    isValidPinpointSubdomain,
};
