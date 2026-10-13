import type {
  Channel,
  EpgChannel,
  ParsedEpg,
  ParsedPlaylist,
  Programme,
} from '../types';
import type { XMLTVParseStats } from '../parsers/xmltv-parser';
import type { XtreamLiveReference } from '../utils/xtream-live-match';
import type { XtreamGroupNameFilter } from '../utils/xtream-category-filter';

export interface M3UWorkerRequest {
  url: string;
  timeout: number;
  xtreamLive?: XtreamLiveReference[];
  xtreamBaseUrl?: string;
  xtreamGroupFilter?: XtreamGroupNameFilter;
}

export interface M3UWorkerResponse {
  data: ParsedPlaylist;
  metrics: {
    transport: 'stream' | 'array_buffer';
    filter: 'none' | 'unavailable' | 'live_catalog';
    inputBytes: number;
    chunks: number;
    channelsKept: number;
    channelsDropped: number;
    elapsedMs: number;
  };
}

export type M3UWorkerChunk =
  | {
      kind: 'channels';
      channels: Channel[];
      inputBytes: number;
      chunks: number;
      channelsEmitted: number;
      channelsDropped: number;
    }
  | {
      kind: 'progress';
      inputBytes: number;
      chunks: number;
      channelsEmitted: number;
      channelsDropped: number;
    };

export interface XMLTVWorkerRequest {
  url: string;
  timeout: number;
  options: {
    nowMs?: number;
    channelIds?: string[];
    channelNames?: string[];
    retainChannelCatalog?: boolean;
    maxProgrammes?: number;
  };
}

export interface XMLTVWorkerResponse {
  data: ParsedEpg;
  stats: XMLTVParseStats;
  metrics: {
    transport: 'stream' | 'array_buffer';
    encoding: 'gzip' | 'plain';
    attempts: number;
    inputBytes: number;
    chunks: number;
    elapsedMs: number;
  };
}

export type XMLTVWorkerChunk =
  | { kind: 'reset'; attempt: number }
  | { kind: 'channels'; attempt: number; entries: Array<[string, EpgChannel]> }
  | { kind: 'programmes'; attempt: number; entries: Array<[string, Programme[]]> }
  | {
      kind: 'progress';
      attempt: number;
      encoding: 'gzip' | 'plain';
      inputBytes: number;
      chunks: number;
    };

export interface SearchIndexRequest {
  sessionId: number;
  reset?: boolean;
  channels?: string[][];
  programmes?: string[][];
  movies?: string[];
  series?: string[];
}

export interface SearchIndexResponse {
  accepted: boolean;
}

export interface SearchQueryRequest {
  sessionId: number;
  query: string;
  limit: number;
  includeCatalog: boolean;
}

export interface SearchRankedIndices {
  indices: number[];
  hasMore: boolean;
}

export interface SearchQueryResponse {
  channels: SearchRankedIndices;
  programmes: SearchRankedIndices;
  movies: SearchRankedIndices;
  series: SearchRankedIndices;
}

export interface ListSearchIndexRequest {
  owner: string;
  sessionId: number;
  mode: 'fields' | 'names';
  documents: string[][];
}

export interface ListSearchQueryRequest {
  owner: string;
  sessionId: number;
  query: string;
}

export interface ScopedSearchReleaseRequest {
  owner: string;
  sessionId: number;
}

export interface MappingSearchDocument {
  id: string;
  channelId: string;
  name: string;
  fields: string[];
  sourceIndex: number;
}

export interface MappingSearchIndexRequest {
  owner: string;
  sessionId: number;
  documents: MappingSearchDocument[];
}

export interface MappingSearchQueryRequest {
  owner: string;
  sessionId: number;
  query: string;
  selectedId: string;
}

export interface AppWorkerTasks {
  'm3u.load': {
    request: M3UWorkerRequest;
    response: M3UWorkerResponse;
    chunk: M3UWorkerChunk;
  };
  'xmltv.load': {
    request: XMLTVWorkerRequest;
    response: XMLTVWorkerResponse;
    chunk: XMLTVWorkerChunk;
  };
  'search.index': {
    request: SearchIndexRequest;
    response: SearchIndexResponse;
  };
  'search.query': {
    request: SearchQueryRequest;
    response: SearchQueryResponse | null;
  };
  'list-search.index': {
    request: ListSearchIndexRequest;
    response: SearchIndexResponse;
  };
  'list-search.query': {
    request: ListSearchQueryRequest;
    response: SearchRankedIndices | null;
  };
  'list-search.release': {
    request: ScopedSearchReleaseRequest;
    response: SearchIndexResponse;
  };
  'mapping-search.index': {
    request: MappingSearchIndexRequest;
    response: SearchIndexResponse;
  };
  'mapping-search.query': {
    request: MappingSearchQueryRequest;
    response: SearchRankedIndices | null;
  };
  'mapping-search.release': {
    request: ScopedSearchReleaseRequest;
    response: SearchIndexResponse;
  };
}
