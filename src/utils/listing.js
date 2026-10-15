// Small helpers shared by the list endpoints (page numbers, search text, the pagination reply)

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A case-insensitive "contains" match for text typed into a search box
export const searchPattern = (text) => new RegExp(escapeRegex(text.trim().slice(0, 100)), "i");

// ?page and ?limit from the address, kept within sensible bounds
export const pageParams = (query, defaultLimit = 20) => ({
  page: Math.max(1, parseInt(query.page, 10) || 1),
  limit: Math.min(100, Math.max(1, parseInt(query.limit, 10) || defaultLimit)),
});

export const paginationOf = (page, limit, total) => ({ page, limit, total, pages: Math.ceil(total / limit) });
