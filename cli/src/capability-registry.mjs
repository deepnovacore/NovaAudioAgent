// Generated from runtime/src/config/capability-registry.ts; run node runtime/scripts/check-capabilities.mjs --write.
/** One dependency-free registry parser, also emitted into the standalone CLI by check-capabilities.mjs. */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
export const DEFAULT_CAPABILITIES_PATH = '~/.nova-audio-agent/capabilities.json';
export const BAILIAN_SEARCH_MCP_URL = 'https://dashscope.aliyuncs.com/api/v1/mcps/EnhancedSearch/mcp';
export const BAILIAN_SEARCH_MCP_TOOL = 'search_pro';
export const DEFAULT_FRONTBRAIN_TOOL_BUDGET = 24;
export const MCP_NON_AUTH_HEADERS = ['accept', 'content-type', 'user-agent'];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const SERVER_NAME = /^[a-z][a-z0-9_]{0,31}$/u;
const MAX_CONFIG_BYTES = 256 * 1024;
/** Legacy `exposeTo.codex` authorizes only Codex; every other backend needs an explicit grant. */
export function mcpBackendAuthorized(config, backend) {
    return config.enabled && (config.exposeTo.backends?.[backend] ?? (backend === 'codex' && config.exposeTo.codex));
}
function backendGrants(value, field) {
    if (value === undefined)
        return undefined;
    const grants = object(value, field, ['codex', 'opencode', 'codebuddy', 'pi', 'deepseek']);
    return Object.fromEntries(Object.entries(grants).map(([key, enabled]) => [key, bool(enabled, false, `${field}.${key}`)]));
}
export class CapabilityConfigurationError extends Error {
    reason;
    code = 'invalid_capabilities_configuration';
    constructor(reason) {
        super(`invalid capabilities configuration: ${reason}`);
        this.reason = reason;
        this.name = 'CapabilityConfigurationError';
    }
}
function environmentOverride(environment, name) {
    const value = environment[name]?.trim();
    return value === '' ? undefined : value;
}
function omittedDefault(value, fallback) { return value === undefined ? fallback : value; }
function invalid(field) { throw new CapabilityConfigurationError(field); }
function object(value, field, keys) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        invalid(field);
    const record = value;
    if (keys !== undefined && Object.keys(record).some(key => !keys.includes(key)))
        invalid(field);
    return record;
}
function bool(value, fallback, field) {
    if (value === undefined)
        return fallback;
    if (typeof value !== 'boolean')
        invalid(field);
    return value;
}
function string(value, field, max = 8192) {
    if (typeof value !== 'string' || value.trim() === '' || value.length > max || /[\u0000\r\n]/u.test(value))
        invalid(field);
    return value;
}
function integer(value, fallback, max, field) {
    if (value === undefined)
        return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max)
        invalid(field);
    return value;
}
function stringMap(value, field) {
    const entries = Object.entries(object(omittedDefault(value, {}), field));
    if (entries.length > 64)
        invalid(field);
    return Object.fromEntries(entries.map(([key, val]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/u.test(key))
            invalid(field);
        if (typeof val !== 'string' || val.length > 8192 || /[\u0000\r\n]/u.test(val))
            invalid(field);
        return [key, val];
    }));
}
export function interpolateCapabilityValue(value, environment) {
    const resolved = value.replace(/\$\{([^}]+)\}/gu, (_match, name) => {
        if (!ENV_NAME.test(name))
            invalid('invalid_environment_reference');
        const replacement = environment[name];
        if (replacement === undefined || replacement.trim() === '')
            invalid(`missing_environment:${name}`);
        if (/[\u0000\r\n]/u.test(replacement))
            invalid(`invalid_environment:${name}`);
        return replacement;
    });
    if (resolved.length > 8192)
        invalid('interpolated_value_too_large');
    return resolved;
}
function missingEnvironment(values, environment) {
    for (const value of values) {
        for (const [, name = ''] of value.matchAll(/\$\{([^}]+)\}/gu)) {
            if (ENV_NAME.test(name) && !environment[name]?.trim())
                return name;
        }
    }
    return undefined;
}
function interpolateMap(value, environment) {
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, interpolateCapabilityValue(val, environment)]));
}
export function validateMcpEndpoint(value, headers = {}) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        invalid('invalid_mcp_endpoint');
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    // Unknown custom headers may themselves be credentials. Only known non-auth metadata is safe on HTTP.
    const hasAuth = Object.keys(headers).some(key => !MCP_NON_AUTH_HEADERS.some(name => name === key.toLowerCase()));
    if (url.username || url.password || url.hash
        || (url.protocol !== 'https:' && (url.protocol !== 'http:' || !loopback || hasAuth)))
        invalid('insecure_mcp_endpoint');
}
function moduleConfig(value, field, keys) {
    return object(omittedDefault(value, {}), field, ['enabled', ...keys]);
}
export function parseCapabilityRegistry(input, environment = {}) {
    const document = object(input, 'document', ['version', 'modules', 'mcpServers', 'frontbrainToolBudget']);
    if (document.version !== 1)
        invalid('version');
    const modules = object(omittedDefault(document.modules, {}), 'modules', ['search', 'camera', 'coding', 'knowledge']);
    const search = moduleConfig(modules.search, 'modules.search', ['provider', 'mcp', 'tavily']);
    const camera = moduleConfig(modules.camera, 'modules.camera', []);
    const coding = moduleConfig(modules.coding, 'modules.coding', []);
    const knowledge = moduleConfig(modules.knowledge, 'modules.knowledge', ['exposeToCodex', 'exposeToBackends']);
    const knowledgeGrants = backendGrants(knowledge.exposeToBackends, 'modules.knowledge.exposeToBackends');
    const legacyKnowledgeGrant = bool(knowledge.exposeToCodex, false, 'modules.knowledge.exposeToCodex');
    const requestedEnabled = bool(search.enabled, true, 'modules.search.enabled');
    const configuredProvider = omittedDefault(search.provider, 'tavily');
    if (configuredProvider !== 'tavily' && configuredProvider !== 'mcp')
        invalid('modules.search.provider');
    const requestedProvider = environmentOverride(environment, 'SEARCH_PROVIDER') ?? configuredProvider;
    if (requestedProvider !== 'tavily' && requestedProvider !== 'mcp')
        invalid('SEARCH_PROVIDER');
    const overrides = [];
    if (environment.SEARCH_PROVIDER?.trim())
        overrides.push('SEARCH_PROVIDER');
    let cameraEnabled = bool(camera.enabled, true, 'modules.camera.enabled');
    const cameraOverride = environment.CAMERA_MODULE_ENABLED?.trim().toLowerCase();
    if (cameraOverride) {
        if (!['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'].includes(cameraOverride))
            invalid('CAMERA_MODULE_ENABLED');
        cameraEnabled = ['true', '1', 'yes', 'on'].includes(cameraOverride);
        overrides.push('CAMERA_MODULE_ENABLED');
    }
    let codingEnabled = bool(coding.enabled, true, 'modules.coding.enabled');
    const codingOverride = environment.CODING_MODULE_ENABLED?.trim().toLowerCase();
    if (codingOverride) {
        if (!['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'].includes(codingOverride))
            invalid('CODING_MODULE_ENABLED');
        codingEnabled = ['true', '1', 'yes', 'on'].includes(codingOverride);
        overrides.push('CODING_MODULE_ENABLED');
    }
    const tavily = object(omittedDefault(search.tavily, {}), 'modules.search.tavily', ['apiKeyEnv']);
    const apiKeyEnv = string(omittedDefault(tavily.apiKeyEnv, 'TAVILY_API_KEY'), 'modules.search.tavily.apiKeyEnv', 128);
    if (!ENV_NAME.test(apiKeyEnv))
        invalid('modules.search.tavily.apiKeyEnv');
    // Search is optional: a missing Tavily key reuses the DashScope key through the Bailian preset, or turns search off.
    const tavilyUnavailable = requestedEnabled && requestedProvider === 'tavily' && !environment[apiKeyEnv]?.trim();
    const fallback = tavilyUnavailable && search.mcp === undefined && !environmentOverride(environment, 'SEARCH_MCP_URL')
        && Boolean(environment.DASHSCOPE_API_KEY?.trim()) ? 'bailian_mcp' : undefined;
    let enabled = requestedEnabled && (!tavilyUnavailable || fallback !== undefined);
    const provider = fallback === undefined ? requestedProvider : 'mcp';
    let reason = tavilyUnavailable ? `missing_environment:${apiKeyEnv}` : undefined;
    let mcp;
    if (search.mcp !== undefined || (enabled && provider === 'mcp')) {
        const config = object(omittedDefault(search.mcp, {}), 'modules.search.mcp', ['url', 'tool', 'headers', 'timeoutMs', 'maxResultBytes']);
        const urlOverride = environmentOverride(environment, 'SEARCH_MCP_URL');
        const toolOverride = environmentOverride(environment, 'SEARCH_MCP_TOOL');
        const preset = !urlOverride && config.url === undefined;
        const configuredUrl = string(omittedDefault(config.url, BAILIAN_SEARCH_MCP_URL), 'modules.search.mcp.url');
        const rawUrl = string(urlOverride ?? configuredUrl, 'modules.search.mcp.url');
        const configuredTool = string(omittedDefault(config.tool, preset ? BAILIAN_SEARCH_MCP_TOOL : 'web_search'), 'modules.search.mcp.tool', 256);
        const tool = string(toolOverride ?? configuredTool, 'modules.search.mcp.tool', 256);
        const rawHeaders = stringMap(omittedDefault(config.headers, preset ? { authorization: 'Bearer ${DASHSCOPE_API_KEY}' } : {}), 'modules.search.mcp.headers');
        // A search endpoint whose key is not set turns search off, like a missing Tavily key.
        const missing = enabled && provider === 'mcp' ? missingEnvironment([rawUrl, ...Object.values(rawHeaders)], environment) : undefined;
        if (missing !== undefined) {
            enabled = false;
            reason = `missing_environment:${missing}`;
        }
        const headers = enabled && provider === 'mcp' ? interpolateMap(rawHeaders, environment) : rawHeaders;
        const url = enabled && provider === 'mcp' ? interpolateCapabilityValue(rawUrl, environment) : rawUrl;
        if (enabled && provider === 'mcp')
            validateMcpEndpoint(url, headers);
        mcp = { url, tool, headers,
            timeoutMs: integer(config.timeoutMs, 8000, 60000, 'modules.search.mcp.timeoutMs'),
            maxResultBytes: integer(config.maxResultBytes, 262144, 1048576, 'modules.search.mcp.maxResultBytes') };
        if (urlOverride)
            overrides.push('SEARCH_MCP_URL');
        if (toolOverride)
            overrides.push('SEARCH_MCP_TOOL');
    }
    const servers = object(omittedDefault(document.mcpServers, {}), 'mcpServers');
    if (Object.keys(servers).length > 8)
        invalid('mcpServers:max_8');
    const mcpServers = Object.create(null);
    const serverStatuses = [];
    for (const [index, [name, value]] of Object.entries(servers).entries()) {
        const safeName = SERVER_NAME.test(name) ? name : `invalid_server_${index + 1}`;
        try {
            if (!SERVER_NAME.test(name))
                invalid('invalid_server_name');
            if (name === 'nova_camera' || name === 'nova_knowledge')
                invalid('reserved_server_name');
            const server = parseServer(value, environment);
            mcpServers[name] = server;
            serverStatuses.push({ name, status: server.enabled ? 'configured' : 'disabled' });
        }
        catch (error) {
            serverStatuses.push({ name: safeName, status: 'failed', reason: error instanceof CapabilityConfigurationError ? error.reason : 'invalid_server' });
        }
    }
    return { version: 1, modules: {
            search: { enabled, provider, tavily: { apiKeyEnv, ...(environment[apiKeyEnv] === undefined ? {} : { apiKey: environment[apiKeyEnv] }) }, ...(mcp === undefined ? {} : { mcp }),
                ...(fallback === undefined ? {} : { fallback }), ...(reason === undefined ? {} : { reason }) },
            camera: { enabled: cameraEnabled }, coding: { enabled: codingEnabled },
            knowledge: { enabled: bool(knowledge.enabled, false, 'modules.knowledge.enabled'),
                exposeToCodex: knowledgeGrants?.codex ?? legacyKnowledgeGrant,
                ...(knowledgeGrants === undefined ? {} : { exposeToBackends: knowledgeGrants }) },
        }, mcpServers, serverStatuses, overrides,
        frontbrainToolBudget: integer(document.frontbrainToolBudget, DEFAULT_FRONTBRAIN_TOOL_BUDGET, 256, 'frontbrainToolBudget') };
}
function parseServer(value, environment) {
    const config = object(value, 'server', ['enabled', 'transport', 'url', 'headers', 'command', 'args', 'env', 'tools', 'exposeTo', 'computerUse']);
    const physical = config.computerUse === undefined ? undefined : object(config.computerUse, 'server.computerUse', ['resource']);
    const computerUse = physical === undefined ? {} : { computerUse: { resource: physical.resource === null ? null : string(physical.resource, 'server.computerUse.resource', 512).trim() } };
    const enabled = bool(config.enabled, true, 'server.enabled');
    const transport = config.transport;
    if (transport !== 'streamable-http' && transport !== 'stdio')
        invalid('server.transport');
    const exposure = object(omittedDefault(config.exposeTo, {}), 'server.exposeTo', ['frontbrain', 'codex', 'backends']);
    const grants = backendGrants(exposure.backends, 'server.exposeTo.backends');
    const legacyCodexGrant = bool(exposure.codex, true, 'server.exposeTo.codex');
    const exposeTo = { frontbrain: bool(exposure.frontbrain, false, 'server.exposeTo.frontbrain'),
        codex: grants?.codex ?? legacyCodexGrant,
        ...(grants === undefined ? {} : { backends: grants }) };
    const rawTools = object(omittedDefault(config.tools, {}), 'server.tools');
    if (Object.keys(rawTools).length > 32)
        invalid('server.tools:max_32');
    const tools = Object.fromEntries(Object.entries(rawTools).map(([name, value]) => {
        string(name, 'server.tool_name', 256);
        const tool = object(value, 'server.tool', ['enabled', 'timeoutMs', 'maxResultBytes', 'maxCallsPerTurn']);
        return [name, { enabled: bool(tool.enabled, false, 'server.tool.enabled'),
                timeoutMs: integer(tool.timeoutMs, 8000, 60000, 'server.tool.timeoutMs'),
                maxResultBytes: integer(tool.maxResultBytes, 32768, 1048576, 'server.tool.maxResultBytes'),
                maxCallsPerTurn: integer(tool.maxCallsPerTurn, 2, 32, 'server.tool.maxCallsPerTurn') }];
    }));
    if (transport === 'streamable-http') {
        if (config.command !== undefined || config.args !== undefined || config.env !== undefined)
            invalid('server.transport_fields');
        const rawHeaders = stringMap(config.headers, 'server.headers');
        const rawUrl = string(config.url, 'server.url');
        const headers = enabled ? interpolateMap(rawHeaders, environment) : rawHeaders;
        const url = enabled ? interpolateCapabilityValue(rawUrl, environment) : rawUrl;
        if (enabled)
            validateMcpEndpoint(url, headers);
        return { ...computerUse, enabled, transport, url, urlInterpolated: /\$\{[A-Za-z_][A-Za-z0-9_]*\}/u.test(rawUrl), headers, tools, exposeTo };
    }
    if (config.url !== undefined || config.headers !== undefined)
        invalid('server.transport_fields');
    const command = string(config.command, 'server.command');
    const args = omittedDefault(config.args, []);
    if (!Array.isArray(args) || args.length > 64 || args.some(arg => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0')))
        invalid('server.args');
    const env = stringMap(config.env, 'server.env');
    if (Object.keys(env).some(key => !ENV_NAME.test(key)))
        invalid('server.env');
    return { ...computerUse, enabled, transport, command, args: args, env: enabled ? interpolateMap(env, environment) : env, tools, exposeTo };
}
export function loadCapabilityRegistry(options = {}) {
    const environment = options.environment ?? process.env;
    const explicitPath = (options.path === '' ? undefined : options.path) ?? environmentOverride(environment, 'CAPABILITIES_CONFIG');
    const path = explicitPath ?? DEFAULT_CAPABILITIES_PATH;
    const explicit = explicitPath !== undefined;
    const resolved = path.startsWith('~/') ? join(options.home ?? homedir(), path.slice(2)) : path;
    let input;
    try {
        const bytes = readFileSync(resolved);
        if (bytes.byteLength > MAX_CONFIG_BYTES)
            invalid('file_too_large');
        input = JSON.parse(bytes.toString('utf8'));
    }
    catch (error) {
        if (!explicit && error.code === 'ENOENT')
            input = { version: 1 };
        else
            throw error instanceof CapabilityConfigurationError ? error : new CapabilityConfigurationError('file_unreadable_or_invalid_json');
    }
    return parseCapabilityRegistry(input, environment);
}
export function capabilityStatus(registry, toolCount = null) {
    return { modules: {
            search: { enabled: registry.modules.search.enabled, provider: registry.modules.search.provider,
                ...(registry.modules.search.fallback === undefined ? {} : { fallback: registry.modules.search.fallback }),
                ...(registry.modules.search.reason === undefined ? {} : { reason: registry.modules.search.reason }) },
            camera: registry.modules.camera, coding: registry.modules.coding, knowledge: registry.modules.knowledge,
        }, servers: registry.serverStatuses, overrides: registry.overrides, toolCount, toolBudget: registry.frontbrainToolBudget };
}
export function inspectCapabilities(options = {}) {
    try {
        const registry = loadCapabilityRegistry(options);
        // A switched or disabled search is a reported degradation, not a failed configuration.
        return { ok: registry.serverStatuses.every(server => server.status !== 'failed'), ...capabilityStatus(registry) };
    }
    catch (error) {
        return { ok: false, reason: error instanceof CapabilityConfigurationError ? error.reason : 'invalid_configuration' };
    }
}
