export const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'for', 'to', 'in', 'of', 'and', 'or', 'is', 'it', 'how',
  'where', 'what', 'with', 'that', 'this', 'does', 'do', 'can', 'should',
  'want', 'need', 'from', 'about',
] as const)

/**
 * Code-meaningful words that must NOT be treated as stop words.
 * These are frequently part of symbol names (e.g. updateContactMutation,
 * createApiQuery, findDeps, useChatRoom, getFileInfo, addListener, showDetails).
 */
export const CODE_MEANINGFUL_WORDS: ReadonlySet<string> = new Set([
  'find', 'get', 'use', 'make', 'show', 'return', 'create', 'add', 'update',
  'delete', 'remove', 'set', 'put', 'post', 'patch', 'fetch', 'load', 'save',
  'send', 'receive', 'handle', 'process', 'build', 'parse', 'format', 'validate',
  'check', 'test', 'run', 'execute', 'init', 'start', 'stop', 'open', 'close',
  'read', 'write', 'copy', 'move', 'rename', 'merge', 'split', 'join', 'filter',
  'map', 'reduce', 'sort', 'search', 'query', 'request', 'response', 'resolve',
  'reject', 'subscribe', 'unsubscribe', 'emit', 'listen', 'dispatch', 'trigger',
  'notify', 'register', 'unregister', 'connect', 'disconnect', 'sync', 'async',
] as const)
