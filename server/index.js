#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as api from "./api.js";
import { encode } from '@toon-format/toon';
import { sanitize_api_response } from './sanitizer.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || null;
let apiSchemaCache = null;
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/complete';

async function refresh_api_schema() {
    apiSchemaCache = await api.api_get_api_schema();
}

// Get version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
const __version__ = packageJson.version;

// Initialize MCP server with name, version, and capabilities
const server = new Server(
    {
        name: "Jellyfish API Server",
        version: __version__
    },
    {
        capabilities: {
            tools: {},      // Enable tools capability
            resources: {}   // Enable resources capability
        }
    }
);

// Helper function to filter out undefined/null/empty array values from parameters
function filter_params(params) {
    const filtered = {};
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0)) {
            filtered[key] = value;
        }
    }
    return filtered;
}

// Helper function to sanitize API response
async function sanitize_response(data) {
    // Check if it's an error response from api.js
    if (data.error) {
        return {
            approved: false,
            message: `Error: ${data.error}${data.message ? `\n${data.message}` : ''}`
        };
    }

    // Encode to TOON first, then sanitize what will actually be sent to LLM
    const toonData = encode(data);
    const sanitizeResult = await sanitize_api_response(toonData);

    if (sanitizeResult.approved) {
        return {
            approved: true,
            message: sanitizeResult.message,
            toonData: toonData
        };
    } else {
        return {
            approved: false,
            message: sanitizeResult.message
        };
    }
}

// Helper function to format sanitized response for MCP tools
function format_tool_response(sanitizeResult) {
    if (sanitizeResult.approved) {
        return {
            content: [{
                type: "text",
                text: `${sanitizeResult.message}\n\n${sanitizeResult.toonData}`
            }]
        };
    } else {
        return {
            content: [{
                type: "text",
                text: sanitizeResult.message
            }]
        };
    }
}

// Helper function to format sanitized response for MCP resources
function format_resource_response(uri, sanitizeResult) {
    if (sanitizeResult.approved) {
        return {
            contents: [{
                uri: uri,
                mimeType: "text/plain",
                text: sanitizeResult.toonData
            }]
        };
    } else {
        return {
            contents: [{
                uri: uri,
                mimeType: "text/plain",
                text: sanitizeResult.message
            }]
        };
    }
}

// Helper function to process tool response (combines sanitize + format)
async function process_tool_response(data) {
    const sanitizeResult = await sanitize_response(data);
    return format_tool_response(sanitizeResult);
}

// Helper function to process resource response (sanitize + format)
async function process_resource_response(uri, data) {
    const sanitizeResult = await sanitize_response(data);
    return format_resource_response(uri, sanitizeResult);
}

function truncate(text, max) {
    if (text === undefined || text === null) {
        return "";
    }
    const value = String(text);
    return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function getArrayField(data, fieldNames) {
    if (Array.isArray(data)) {
        return data;
    }
    if (data && typeof data === 'object') {
        for (const field of fieldNames) {
            if (Array.isArray(data[field])) {
                return data[field];
            }
        }
    }
    return [];
}

function normalizeTicket(item) {
    const title = item.name || item.title || item.summary || item.issue_title || item.subject || "";
    const description = item.description || item.long_description || item.details || item.summary || item.notes || "";
    const key = item.key || item.jira_key || item.issue_key || item.ticket_key || item.id || "";
    return {
        key: String(key),
        title: truncate(title, 200),
        description: truncate(description, 1000)
    };
}

function normalizePullRequest(item) {
    return {
        id: item.id || item.pull_request_number || item.pr_id || "",
        title: truncate(item.title || item.name || item.summary || item.subject || "", 200),
        description: truncate(item.description || item.body || item.details || "", 500)
    };
}

function extractCategories(data) {
    return getArrayField(data, ["work_categories", "results", "data"]);
}

function extractTickets(data) {
    return getArrayField(data, ["work_category_contents", "results", "data", "items", "contents"]);
}

function extractPullRequests(data) {
    return getArrayField(data, ["unlinked_pull_requests", "results", "data"]);
}

function parseDateRange(dateRange) {
    if (!dateRange) {
        return {};
    }
    if (typeof dateRange === 'string') {
        const parts = dateRange.split(/\s+to\s+|,|\|/i).map(part => part.trim()).filter(Boolean);
        if (parts.length === 2) {
            return { start_date: parts[0], end_date: parts[1] };
        }
        return {};
    }
    if (typeof dateRange === 'object' && dateRange.start_date && dateRange.end_date) {
        return { start_date: dateRange.start_date, end_date: dateRange.end_date };
    }
    return {};
}

function buildPrompt(pr, candidates, maxSuggestions) {
    const candidateList = candidates.slice(0, 20).map((ticket, index) => {
        return `${index + 1}. ${ticket.key || '[unknown key]'} | ${ticket.title}
Description: ${ticket.description}`;
    }).join('\n\n');

    return `Human: Match the pull request below to the best Jira ticket candidates.

PR Title: ${pr.title}
PR Description: ${pr.description}

Candidate tickets:
${candidateList}

Return a JSON array of objects with keys: key, title, confidence. Use a confidence score from 0.0 to 1.0. Return at most ${maxSuggestions} suggestions. Do not include any text outside the JSON array.

Assistant:`;
}

function parseAnthropicResponse(text) {
    try {
        return JSON.parse(text);
    } catch (error) {
        const jsonMatch = text.match(/(\[\s*\{[\s\S]*\}\s*\])/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[1]);
        }
        throw new Error('Unable to parse Anthropic response as JSON');
    }
}

async function callAnthropic(prompt) {
    if (!ANTHROPIC_API_KEY) {
        return { error: 'No Anthropic API key found. Set process.env.ANTHROPIC_API_KEY.' };
    }

    const response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-API-Key': ANTHROPIC_API_KEY
        },
        body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            prompt,
            max_tokens_to_sample: 256,
            temperature: 0.0,
            stop_sequences: ['\n\nHuman:']
        })
    });

    if (!response.ok) {
        const body = await response.text();
        return { error: `Anthropic API request failed with status ${response.status}`, message: body };
    }

    const result = await response.json();
    if (!result.completion) {
        return { error: 'Anthropic response missing completion text' };
    }
    return result.completion;
}

async function collectCandidateTickets(params) {
    const categoriesData = await api.api_work_categories({ format: 'json' });
    const categories = extractCategories(categoriesData);
    const tickets = [];

    for (const category of categories) {
        const slug = category.slug || category.work_category_slug || category.name;
        if (!slug) {
            continue;
        }
        const categoryParams = {
            work_category_slug: slug,
            format: 'json',
            ...params
        };
        const contentsData = await api.api_work_category_contents(categoryParams);
        tickets.push(...extractTickets(contentsData));
    }

    return tickets.map(normalizeTicket).filter(ticket => ticket.title || ticket.key);
}

export async function suggest_pr_jira_links(params = {}) {
    const minConfidence = Number(params.min_confidence ?? 0.5);
    const maxSuggestions = Number(params.max_suggestions_per_pr ?? 3);
    const { start_date, end_date } = parseDateRange(params.date_range);
    const teamId = params.team_id;

    if (Number.isNaN(minConfidence) || minConfidence < 0.0 || minConfidence > 1.0) {
        return { error: 'min_confidence must be a number between 0.0 and 1.0' };
    }
    if (!Number.isInteger(maxSuggestions) || maxSuggestions < 1) {
        return { error: 'max_suggestions_per_pr must be a positive integer' };
    }

    const prParams = {};
    if (start_date) prParams.start_date = start_date;
    if (end_date) prParams.end_date = end_date;
    if (teamId !== undefined) prParams.team_id = teamId;

    const prData = await api.api_unlinked_pull_requests(prParams);
    const prItems = extractPullRequests(prData);
    if (prItems.length === 0) {
        return { suggestions: [] };
    }

    const candidateParams = {};
    if (start_date) candidateParams.start_date = start_date;
    if (end_date) candidateParams.end_date = end_date;
    if (teamId !== undefined) candidateParams.team_id = teamId;

    const rawCandidates = await collectCandidateTickets(candidateParams);
    if (rawCandidates.length === 0) {
        if (!apiSchemaCache) {
            apiSchemaCache = await api.api_get_api_schema();
        }
        return { error: 'Unable to retrieve candidate tickets from work_category_contents using existing schema.' };
    }

    const suggestions = [];
    for (const prItem of prItems) {
        const pr = normalizePullRequest(prItem);
        const prompt = buildPrompt(pr, rawCandidates, maxSuggestions);
        const llmResult = await callAnthropic(prompt);
        if (llmResult.error) {
            return llmResult;
        }

        let matches;
        try {
            matches = parseAnthropicResponse(llmResult);
        } catch (error) {
            return { error: error.message };
        }

        const normalized = Array.isArray(matches) ? matches
            .filter(match => typeof match === 'object' && match !== null)
            .map(match => ({
                key: String(match.key || match.id || match.issue_key || ''),
                title: truncate(match.title || match.name || '', 200),
                confidence: Math.max(0, Math.min(1, Number(match.confidence || 0)))
            }))
            .filter(match => match.key && match.confidence >= minConfidence)
            .slice(0, maxSuggestions)
            : [];

        suggestions.push({
            pull_request: pr,
            suggestions: normalized
        });
    }

    return {
        suggestions,
        candidate_ticket_count: rawCandidates.length,
        pull_request_count: prItems.length
    };
}

export async function suggest_pr_jira_links_from_data(prs, candidates, options = {}) {
    const minConfidence = Number(options.min_confidence ?? 0.5);
    const maxSuggestions = Number(options.max_suggestions_per_pr ?? 3);
    const normalizedCandidates = candidates.map(normalizeTicket).filter(ticket => ticket.title || ticket.key);
    const suggestions = [];

    for (const prItem of prs) {
        const pr = normalizePullRequest(prItem);
        const prompt = buildPrompt(pr, normalizedCandidates, maxSuggestions);
        const llmResult = await callAnthropic(prompt);
        if (llmResult.error) {
            return llmResult;
        }

        let matches;
        try {
            matches = parseAnthropicResponse(llmResult);
        } catch (error) {
            return { error: error.message };
        }

        const normalized = Array.isArray(matches) ? matches
            .filter(match => typeof match === 'object' && match !== null)
            .map(match => ({
                key: String(match.key || match.id || match.issue_key || ''),
                title: truncate(match.title || match.name || '', 200),
                confidence: Math.max(0, Math.min(1, Number(match.confidence || 0)))
            }))
            .filter(match => match.key && match.confidence >= minConfidence)
            .slice(0, maxSuggestions)
            : [];

        suggestions.push({ pull_request: pr, suggestions: normalized });
    }

    return {
        suggestions,
        candidate_ticket_count: normalizedCandidates.length,
        pull_request_count: prs.length
    };
}

// Handler to list all available resources (returns API schema resource)
server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
        resources: [
            {
                uri: "schema://api",
                mimeType: "application/json",
                name: "api_schema",
                description: "Get the complete API schema with all available endpoints"
            }
        ]
    };
});

// Handler to read specific resources when requested by URI
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri == "schema://api") {
        const data = await api.api_get_api_schema();
        return process_resource_response("schema://api", data);
    }
    throw new Error(`Unknown resource: ${request.params.uri}`);
});

// Handler to list all available tools (returns Jellyfish API tools)
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            // ALLOCATIONS
            {
                name: "allocations_by_person",
                description: "Returns allocation data for the whole company, aggregated by person.",
                inputSchema: {
                    type: "object",
                    properties: {
                        format: { type: "string", default: "json", description: "Response format" },
                        start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
                        end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
                        unit: { type: "string", description: "Time unit (\"quarter\", \"month\", \"week\")" },
                        series: { type: "boolean", description: "Whether to return series data" },
                        decimal_places: { type: "integer", description: "Show FTE amounts rounded to this many decimal places (1 to 3). Defaults to 1." },
                        include_below_threshold_card_keys: { type: "boolean", description: "Include allocated card keys that round to 0 FTE. Omit when using max_n_allocation_card_keys (default true works well). Set to false when omitting max_n_allocation_card_keys to limit excessive data volume from minor allocations." },
                        max_n_allocation_card_keys: { type: "integer", description: "CRITICAL: Limits card keys per entry to top N by allocation to prevent massive responses. Default (omitted) returns ALL card keys which is rarely advised. RECOMMENDED VALUES: 0=totals only (no card-level detail needed), 3-5=executive summary, 5-10=standard analysis, 10-20=detailed analysis." }
                    },
                    required: []
                }
            },
            {
                name: "allocations_by_team",
                description: "Returns allocation data for the whole company, aggregated by team at the specified hierarchy level.",
                inputSchema: {
                    type: "object",
                    properties: {
                        format: { type: "string", default: "json", description: "Response format" },
                        start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
                        end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
                        unit: { type: "string", description: "Time unit (\"quarter\", \"month\", \"week\")" },
                        series: { type: "boolean", description: "Whether to return series data" },
                        decimal_places: { type: "integer", description: "Show FTE amounts rounded to this many decimal places (1 to 3). Defaults to 1." },
                        include_below_threshold_card_keys: { type: "boolean", description: "Include allocated card keys that round to 0 FTE. Omit when using max_n_allocation_card_keys (default true works well). Set to false when omitting max_n_allocation_card_keys to limit excessive data volume from minor allocations." },
                        max_n_allocation_card_keys: { type: "integer", description: "CRITICAL: Limits card keys per entry to top N by allocation to prevent massive responses. Default (omitted) returns ALL card keys which is rarely advised. RECOMMENDED VALUES: 0=totals only (no card-level detail needed), 3-5=executive summary, 5-10=standard analysis, 10-20=detailed analysis." },
                        team_hierarchy_level: { type: "integer", description: "Returns allocation details for each unit at the hierarchy Org Level represented by this number. The highest Org Level in your Organization Structure is '1', the Org Level just beneath that is '2', and so on. E.g., For a Division > Group > Team hierarchy, Division is 1, Group is 2, Team is 3." },
                        include_person_breakout: { type: "boolean", description: "Include person details" }
                    },
                    required: ["team_hierarchy_level"]
                }
            },
            {
                name: "allocations_by_investment_category",
                description: "Returns allocation data for the whole company, aggregated by investment category.",
                inputSchema: {
                    type: "object",
                    properties: {
                        format: { type: "string", default: "json", description: "Response format" },
                        start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
                        end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
                        unit: { type: "string", description: "Time unit (\"quarter\", \"month\", \"week\")" },
                        series: { type: "boolean", description: "Whether to return series data" },
                        decimal_places: { type: "integer", description: "Show FTE amounts rounded to this many decimal places (1 to 3). Defaults to 1." },
                        include_below_threshold_card_keys: { type: "boolean", description: "Include allocated card keys that round to 0 FTE. Omit when using max_n_allocation_card_keys (default true works well). Set to false when omitting max_n_allocation_card_keys to limit excessive data volume from minor allocations." },
                        max_n_allocation_card_keys: { type: "integer", description: "CRITICAL: Limits card keys per entry to top N by allocation to prevent massive responses. Default (omitted) returns ALL card keys which is rarely advised. RECOMMENDED VALUES: 0=totals only (no card-level detail needed), 3-5=executive summary, 5-10=standard analysis, 10-20=detailed analysis." }
                    },
                    required: []
                }
            },
            {
                name: "allocations_by_investment_category_person",
                description: "Returns allocation data for the whole company, aggregated by investment category and person.",
                inputSchema: {
                    type: "object",
                    properties: {
                        format: { type: "string", default: "json", description: "Response format" },
                        start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
                        end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
                        unit: { type: "string", description: "Time unit (\"quarter\", \"month\", \"week\")" },
                        series: { type: "boolean", description: "Whether to return series data" },
                        decimal_places: { type: "integer", description: "Show FTE amounts rounded to this many decimal places (1 to 3). Defaults to 1." },
                        include_below_threshold_card_keys: { type: "boolean", description: "Include allocated card keys that round to 0 FTE. Omit when using max_n_allocation_card_keys (default true works well). Set to false when omitting max_n_allocation_card_keys to limit excessive data volume from minor allocations." },
                        max_n_allocation_card_keys: { type: "integer", description: "CRITICAL: Limits card keys per entry to top N by allocation to prevent massive responses. Default (omitted) returns ALL card keys which is rarely advised. RECOMMENDED VALUES: 0=totals only (no card-level detail needed), 3-5=executive summary, 5-10=standard analysis, 10-20=detailed analysis." }
                    },
                    required: []
                }
            },
            {
                name: "allocations_by_investment_category_team",
                description: "Returns allocation data for the whole company, aggregated by investment category and team at the specified hierarchy level.",
                inputSchema: {
                    type: "object",
                    properties: {
                        format: { type: "string", default: "json", description: "Response format" },
                        start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
                        end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
                        unit: { type: "string", description: "Time unit (\"quarter\", \"month\", \"week\")" },
                        series: { type: "boolean", description: "Whether to return series data" },
                        decimal_places: { type: "integer", description: "Show FTE amounts rounded to this many decimal places (1 to 3). Defaults to 1." },
                        include_below_threshold_card_keys: { type: "boolean", description: "Include allocated card keys that round to 0 FTE. Omit when using max_n_allocation_card_keys (default true works well). Set to false when omitting max_n_allocation_card_keys to limit excessive data volume from minor allocations." },
                        max_n_allocation_card_keys: { type: "integer", description: "CRITICAL: Limits card keys per entry to top N by allocation to prevent massive responses. Default (omitted) returns ALL card keys which is rarely advised. RECOMMENDED VALUES: 0=totals only (no card-level detail needed), 3-5=executive summary, 5-10=standard analysis, 10-20=detailed analysis." },
                        team_hierarchy_level: { type: "integer", description: "Returns allocation details for each unit at the hierarchy Org Level represented by this number. The highest Org Level in your Organization Structure is '1', the Org Level just beneath that is '2', and so on. E.g., For a Division > Group > Team hierarchy, Division is 1, Group is 2, Team is 3." },
                        include_person_breakout: { type: "boolean", description: "Include person details" }
                    },
                    required: ["team_hierarchy_level"]
                }
            },
            {
                name: "allocations_by_work_category",
                description: "Returns allocation data for the whole company, aggregated by deliverable within the specified work category.",
                inputSchema: {
                    type: "object",
                    properties: {
                        format: { type: "string", default: "json", description: "Response format" },
                        start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
                        end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
                        unit: { type: "string", description: "Time unit (\"quarter\", \"month\", \"week\")" },
                        series: { type: "boolean", description: "Whether to return series data" },
                        decimal_places: { type: "integer", description: "Show FTE amounts rounded to this many decimal places (1 to 3). Defaults to 1." },
                        include_below_threshold_card_keys: { type: "boolean", description: "Include allocated card keys that round to 0 FTE. Omit when using max_n_allocation_card_keys (default true works well). Set to false when omitting max_n_allocation_card_keys to limit excessive data volume from minor allocations." },
                        max_n_allocation_card_keys: { type: "integer", description: "CRITICAL: Limits card keys per entry to top N by allocation to prevent massive responses. Default (omitted) returns ALL card keys which is rarely advised. RECOMMENDED VALUES: 0=totals only (no card-level detail needed), 3-5=executive summary, 5-10=standard analysis, 10-20=detailed analysis." },
                        work_category_slug: { type: "string", description: "Work category slug" }
                    },
                    required: ["work_category_slug"]
                }
            },
            {
                name: "allocations_by_work_category_person",
                description: "Returns allocation data for the whole company, aggregated by deliverable within the specified work category and person.",
                inputSchema: {
                    type: "object",
                    properties: {
                        format: { type: "string", default: "json", description: "Response format" },
                        start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
                        end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
                        unit: { type: "string", description: "Time unit (\"quarter\", \"month\", \"week\")" },
                        series: { type: "boolean", description: "Whether to return series data" },
                        decimal_places: { type: "integer", description: "Show FTE amounts rounded to this many decimal places (1 to 3). Defaults to 1." },
                        include_below_threshold_card_keys: { type: "boolean", description: "Include allocated card keys that round to 0 FTE. Omit when using max_n_allocation_card_keys (default true works well). Set to false when omitting max_n_allocation_card_keys to limit excessive data volume from minor allocations." },
                        max_n_allocation_card_keys: { type: "integer", description: "CRITICAL: Limits card keys per entry to top N by allocation to prevent massive responses. Default (omitted) returns ALL card keys which is rarely advised. RECOMMENDED VALUES: 0=totals only (no card-level detail needed), 3-5=executive summary, 5-10=standard analysis, 10-20=detailed analysis." },
                        work_category_slug: { type: "string", description: "Work category slug" }
                    },
                    required: ["work_category_slug"]
                }
            },
            {
                name: "allocations_by_work_category_team",
                description: "Returns allocation data for the whole company, aggregated by deliverable within the specified work category and team at the specified hierarchy level.",
                inputSchema: {
                    type: "object",
                    properties: {
                        format: { type: "string", default: "json", description: "Response format" },
                        start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
                        end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
                        unit: { type: "string", description: "Time unit (\"quarter\", \"month\", \"week\")" },
                        series: { type: "boolean", description: "Whether to return series data" },
                        decimal_places: { type: "integer", description: "Show FTE amounts rounded to this many decimal places (1 to 3). Defaults to 1." },
                        include_below_threshold_card_keys: { type: "boolean", description: "Include allocated card keys that round to 0 FTE. Omit when using max_n_allocation_card_keys (default true works well). Set to false when omitting max_n_allocation_card_keys to limit excessive data volume from minor allocations." },
                        max_n_allocation_card_keys: { type: "integer", description: "CRITICAL: Limits card keys per entry to top N by allocation to prevent massive responses. Default (omitted) returns ALL card keys which is rarely advised. RECOMMENDED VALUES: 0=totals only (no card-level detail needed), 3-5=executive summary, 5-10=standard analysis, 10-20=detailed analysis." },
                        team_hierarchy_level: { type: "integer", description: "Returns allocation details for each unit at the hierarchy Org Level represented by this number. The highest Org Level in your Organization Structure is '1', the Org Level just beneath that is '2', and so on. E.g., For a Division > Group > Team hierarchy, Division is 1, Group is 2, Team is 3." },
                        work_category_slug: { type: "string", description: "Work category slug" },
                        include_person_breakout: { type: "boolean", description: "Include person details" }
                    },
                    required: ["team_hierarchy_level", "work_category_slug"]
                }
            },
            {
                name: "allocations_filter_fields",
                description: "Returns a list of the available fields and known values for filtering allocations.",
                inputSchema: {
                    type: "object",
                    properties: {},
                    required: []
                }
            },
            {
                name: "allocations_summary_by_investment_category",
                description: "Returns total FTE amounts for investment categories. This call supports filtering which people are included in the totals.",
                inputSchema: {
                    type: "object",
                    properties: {
                        format: { type: "string", default: "json", description: "Response format" },
                        start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
                        end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
                        unit: { type: "string", description: "Time unit (\"quarter\", \"month\", \"week\", \"sprint\")" },
                        series: { type: "boolean", description: "Whether to return series data" },
                        decimal_places: { type: "integer", description: "Show FTE amounts rounded to this many decimal places (1 to 3). Defaults to 1." },
                        include_below_threshold_card_keys: { type: "boolean", description: "Include allocated card keys that round to 0 FTE. Omit when using max_n_allocation_card_keys (default true works well). Set to false when omitting max_n_allocation_card_keys to limit excessive data volume from minor allocations." },
                        max_n_allocation_card_keys: { type: "integer", description: "CRITICAL: Limits card keys per entry to top N by allocation to prevent massive responses. Default (omitted) returns ALL card keys which is rarely advised. RECOMMENDED VALUES: 0=totals only (no card-level detail needed), 3-5=executive summary, 5-10=standard analysis, 10-20=detailed analysis." },
                        team_id: { type: "array", items: {type: "string"}, description: "List of team IDs. Returns total FTE amounts for only people in these team IDs, all of which must be at the same hierarchy org level. Can include 'null' for people with no team." },
                        role: { type: "array", items: {type: "string"}, description: "List of roles. Returns total FTE amounts for only people with these roles. Can include 'null' for people with no role. To check what roles are available, use the allocations_filter_fields tool." },
                        location: { type: "array", items: {type: "string"}, description: "List of locations. Returns total FTE amounts for only people with these locations. Can include 'null' for people with no location. To check what locations are available, use the allocations_filter_fields tool." },
                        custom_column_laptop: { type: "array", items: {type: "string"}, description: "List of laptop types. Returns total FTE amounts for only people with these custom field values. Can include 'null' for people with no value for this field. To check what values are available, use the allocations_filter_fields tool." }
                    },
                    required: []
                }
            },
            {
                name: "allocations_summary_by_work_category",
                description: "Returns total FTE amounts for deliverables within a work category. Supports filtering.",
                inputSchema: {
                    type: "object",
                    properties: {
                        format: { type: "string", default: "json", description: "Response format" },
                        start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
                        end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
                        unit: { type: "string", description: "Time unit (\"quarter\", \"month\", \"week\", \"sprint\")" },
                        series: { type: "boolean", description: "Whether to return series data" },
                        decimal_places: { type: "integer", description: "Show FTE amounts rounded to this many decimal places (1 to 3). Defaults to 1." },
                        include_below_threshold_card_keys: { type: "boolean", description: "Include allocated card keys that round to 0 FTE. Omit when using max_n_allocation_card_keys (default true works well). Set to false when omitting max_n_allocation_card_keys to limit excessive data volume from minor allocations." },
                        max_n_allocation_card_keys: { type: "integer", description: "CRITICAL: Limits card keys per entry to top N by allocation to prevent massive responses. Default (omitted) returns ALL card keys which is rarely advised. RECOMMENDED VALUES: 0=totals only (no card-level detail needed), 3-5=executive summary, 5-10=standard analysis, 10-20=detailed analysis." },
                        team_id: { type: "array", items: {type: "string"}, description: "List of team IDs. Returns total FTE amounts for only people in these team IDs, all of which must be at the same hierarchy org level. Can include 'null' for people with no team." },
                        role: { type: "array", items: {type: "string"}, description: "List of roles. Returns total FTE amounts for only people with these roles. Can include 'null' for people with no role. To check what roles are available, use the allocations_filter_fields tool." },
                        location: { type: "array", items: {type: "string"}, description: "List of locations. Returns total FTE amounts for only people with these locations. Can include 'null' for people with no location. To check what locations are available, use the allocations_filter_fields tool." },
                        work_category_slug: { type: "string", description: "Work category slug" },
                        custom_column_laptop: { type: "array", items: {type: "string"}, description: "List of laptop types. Returns total FTE amounts for only people with these custom field values. Can include 'null' for people with no value for this field. To check what values are available, use the allocations_filter_fields tool." }
                    },
                    required: ["work_category_slug"]
                }
            },
            // DELIVERY
            {
                name: "deliverable_details",
                description: "Returns data about a specific deliverable.",
                inputSchema: {
                    type: "object",
                    properties: {
                        format: { type: "string", default: "json", description: "Response format" },
                        deliverable_id: { type: "integer", description: "Jellyfish deliverable id" }
                    },
                    required: ["deliverable_id"]
                }
            },
            {
                name: "deliverable_scope_and_effort_history",
                description: "Returns weekly data about the scope of a deliverable and the total effort allocated per week.",
                inputSchema: {
                    type: "object",
                    properties: {
                        format: { type: "string", default: "json", description: "Response format" },
                        deliverable_id: { type: "integer", description: "Jellyfish deliverable id" },
                        start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
                        end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
                        unit: { type: "string", description: "Time unit (\"quarter\", \"month\", \"week\")" }
                    },
                    required: ["deliverable_id"]
                }
            },
            {
                name: "work_categories",
                description: "Returns a list of all known work categories.",
                inputSchema: {
                    type: "object",
                    properties: {},
                    required: []
                }
            },
            {
                name: "work_category_contents",
                description: "Returns data about the deliverables in a specified work category.",
                inputSchema: {
                    type: "object",
                    properties: {
                        format: { type: "string", default: "json", description: "Response format" },
                        start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
                        end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
                        unit: { type: "string", description: "Time unit (\"quarter\", \"month\", \"week\")" },
                        series: { type: "boolean", description: "Whether to return series data" },
                        work_category_slug: { type: "string", description: "Work category slug" },
                        completed_only: { type: "boolean", description: "Only completed deliverables" },
                        inprogress_only: { type: "boolean", description: "Only in-progress deliverables" },
                        view_archived: { type: "boolean", description: "Include archived deliverables" },
                        team_id: { type: "array", items: {type: "integer"}, description: "List of team IDs" }
                    },
                    required: ["work_category_slug"]
                }
            },
            {
                name: "suggest_pr_jira_links",
                description: "Suggest Jira ticket matches for unlinked PRs using semantic matching.",
                inputSchema: {
                    type: "object",
                    properties: {
                        team_id: {
                            oneOf: [
                                { type: "integer" },
                                { type: "string" },
                                { type: "array", items: { type: "integer" } }
                            ],
                            description: "Team ID or list of team IDs used to filter candidate tickets."
                        },
                        date_range: {
                            type: "object",
                            properties: {
                                start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
                                end_date: { type: "string", description: "End date (YYYY-MM-DD)" }
                            },
                            required: ["start_date", "end_date"],
                            description: "Date range used to filter PRs and candidate tickets."
                        },
                        min_confidence: { type: "number", default: 0.5, description: "Minimum confidence threshold for suggestions (0.0 to 1.0)." },
                        max_suggestions_per_pr: { type: "integer", default: 3, description: "Maximum number of suggestions to return per PR." }
                    },
                    required: []
                }
            },
            // DEVEX
            {
                name: "devex_insights_by_team",
                description: "Returns DevEx insights data.",
                inputSchema: {
                    type: "object",
                    properties: {
                        format: { type: "string", default: "json", description: "Response format" },
                        start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
                        end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
                        unit: { type: "string", description: "Time unit (\"quarter\", \"month\", \"week\")" },
                        id: { type: "integer", description: "Jellyfish team id" },
                        devex_team_ref: { type: "string", description: "Unique identifier for a team in DevEx" },
                        team_id: { type: "integer", description: "Jellyfish team id" },
                        series_id: { type: "string", description: "Unique identifier for a series in DevEx" },
                        survey_id: { type: "string", description: "Unique identifier for a survey in DevEx" }
                    },
                    required: []
                }
            },
            // METRICS
            {
                name: "company_metrics",
                description: "Returns metrics data for the company during the specified timeframe.",
                inputSchema: {
                    type: "object",
                    properties: {
                        format: { type: "string", default: "json", description: "Response format" },
                        start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
                        end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
                        unit: { type: "string", description: "Time unit (\"quarter\", \"month\", \"week\")" },
                        series: { type: "boolean", description: "Whether to return series data" }
                    },
                    required: []
                }
            },
            {
                name: "person_metrics",
                description: "Returns metrics data for the specified person during the specified timeframe.",
                inputSchema: {
                    type: "object",
                    properties: {
                        format: { type: "string", default: "json", description: "Response format" },
                        start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
                        end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
                        unit: { type: "string", description: "Time unit (\"quarter\", \"month\", \"week\")" },
                        series: { type: "boolean", description: "Whether to return series data" },
                        person_id: { type: "array", items: {type: "integer"}, description: "List of person IDs" }
                    },
                    required: ["person_id"]
                }
            },
            {
                name: "team_metrics",
                description: "Returns metrics data for the specified team during the specified timeframe.",
                inputSchema: {
                    type: "object",
                    properties: {
                        format: { type: "string", default: "json", description: "Response format" },
                        start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
                        end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
                        unit: { type: "string", description: "Time unit (\"quarter\", \"month\", \"week\", \"sprint\")" },
                        series: { type: "boolean", description: "Whether to return series data" },
                        team_id: { type: "array", items: {type: "integer"}, description: "List of team IDs" }
                    },
                    required: ["team_id"]
                }
            },
            {
                name: "team_sprint_summary",
                description: "Returns issue count and, if available, story point data for a team's sprints in the specified timeframe.",
                inputSchema: {
                    type: "object",
                    properties: {
                        format: { type: "string", default: "json", description: "Response format" },
                        start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
                        end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
                        team_id: { type: "integer", description: "Team ID" }
                    },
                    required: ["team_id"]
                }
            },
            {
                name: "unlinked_pull_requests",
                description: "Lists details of unlinked pull requests merged during the specified timeframe.",
                inputSchema: {
                    type: "object",
                    properties: {
                        format: { type: "string", default: "json", description: "Response format" },
                        start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
                        end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
                        unit: { type: "string", description: "Time unit (\"quarter\", \"month\", \"week\")" },
                        series: { type: "boolean", description: "Whether to return series data" },
                        instance_slug: { type: "array", items: {type: "string"}, description: "List of git instance slugs" },
                        organization_name: { type: "array", items: {type: "string"}, description: "List of organization names" },
                        repo_name: { type: "array", items: {type: "string"}, description: "List of repository names" }
                    },
                    required: []
                }
            },
            // PEOPLE
            {
                name: "list_engineers",
                description: "Returns a list of all active allocatable people as of a specific date.",
                inputSchema: {
                    type: "object",
                    properties: {
                        format: { type: "string", default: "json", description: "Response format" },
                        effective_date: { type: "string", description: "Effective date (YYYY-MM-DD)" }
                    },
                    required: []
                }
            },
            {
                name: "search_people",
                description: "Searches for people by name, email, or id.",
                inputSchema: {
                    type: "object",
                    properties: {
                        format: { type: "string", default: "json", description: "Response format" },
                        name: { type: "array", items: {type: "string"}, description: "List of names" },
                        email: { type: "array", items: {type: "string"}, description: "List of emails" },
                        person_id: { type: "array", items: {type: "integer"}, description: "List of person IDs" }
                    },
                    required: []
                }
            },
            // TEAMS
            {
                name: "list_teams",
                description: "Displays all teams at the specified hierarchy level. Optionally, includes child teams.",
                inputSchema: {
                    type: "object",
                    properties: {
                        format: { type: "string", default: "json", description: "Response format" },
                        hierarchy_level: { type: "integer", description: "Team hierarchy level" },
                        include_children: { type: "boolean", description: "Whether to include child teams" }
                    },
                    required: ["hierarchy_level"]
                }
            },
            {
                name: "search_teams",
                description: "Searches for teams by name or id. It does not include child or parent information. It returns id, name, active, hierarchy_level, and hierarchy_level_name. Note: While name and team_id are both optional, at least one must be provided.",
                inputSchema: {
                    type: "object",
                    properties: {
                        format: { type: "string", default: "json", description: "Response format" },
                        name: { type: "array", items: {type: "string"}, description: "List of team names" },
                        team_id: { type: "array", items: {type: "integer"}, description: "List of team IDs" }
                    },
                    required: []
                }
            }
        ]
    };
});

// Handler to execute tool calls (processes requests for all 24 Jellyfish API tools)
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const params = filter_params(request.params.arguments || {});

    switch (request.params.name) {
        // ALLOCATIONS
        case "allocations_by_person":
            return process_tool_response(await api.api_allocations_by_person(params));
        case "allocations_by_team":
            return process_tool_response(await api.api_allocations_by_team(params));
        case "allocations_by_investment_category":
            return process_tool_response(await api.api_allocations_by_investment_category(params));
        case "allocations_by_investment_category_person":
            return process_tool_response(await api.api_allocations_by_investment_category_person(params));
        case "allocations_by_investment_category_team":
            return process_tool_response(await api.api_allocations_by_investment_category_team(params));
        case "allocations_by_work_category":
            return process_tool_response(await api.api_allocations_by_work_category(params));
        case "allocations_by_work_category_person":
            return process_tool_response(await api.api_allocations_by_work_category_person(params));
        case "allocations_by_work_category_team":
            return process_tool_response(await api.api_allocations_by_work_category_team(params));
        case "allocations_filter_fields":
            return process_tool_response(await api.api_allocations_filter_fields({ format: "json" }));
        case "allocations_summary_by_investment_category":
            return process_tool_response(await api.api_allocations_summary_by_investment_category(params));
        case "allocations_summary_by_work_category":
            return process_tool_response(await api.api_allocations_summary_by_work_category(params));

        // DELIVERY
        case "deliverable_details":
            return process_tool_response(await api.api_deliverable_details(params));
        case "deliverable_scope_and_effort_history":
            return process_tool_response(await api.api_deliverable_scope_and_effort_history(params));
        case "work_categories":
            return process_tool_response(await api.api_work_categories({ format: "json" }));
        case "work_category_contents":
            return process_tool_response(await api.api_work_category_contents(params));

        // DEVEX
        case "devex_insights_by_team":
            return process_tool_response(await api.api_devex_insights_by_team(params));

        // METRICS
        case "company_metrics":
            return process_tool_response(await api.api_company_metrics(params));
        case "person_metrics":
            return process_tool_response(await api.api_person_metrics(params));
        case "team_metrics":
            return process_tool_response(await api.api_team_metrics(params));
        case "team_sprint_summary":
            return process_tool_response(await api.api_team_sprint_summary(params));
        case "unlinked_pull_requests":
            return process_tool_response(await api.api_unlinked_pull_requests(params));
        case "suggest_pr_jira_links":
            return process_tool_response(await suggest_pr_jira_links(params));

        // PEOPLE
        case "list_engineers":
            return process_tool_response(await api.api_list_engineers(params));
        case "search_people":
            return process_tool_response(await api.api_search_people(params));

        // TEAMS
        case "list_teams":
            return process_tool_response(await api.api_list_teams(params));
        case "search_teams":
            return process_tool_response(await api.api_search_teams(params));
        
        default:
            throw new Error(`Unknown tool: ${request.params.name}`);
    }
});

// Main function to start the MCP server with stdio transport
async function main() {
    await refresh_api_schema();
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch(console.error);
}