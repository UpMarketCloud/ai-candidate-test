/**
 * Shared Test Utilities for Unit Tests
 * =====================================
 *
 * This module provides reusable utilities for unit testing across the codebase.
 * Using these utilities ensures consistent test setup and reduces boilerplate.
 *
 * Contents:
 *   - HTTP Service Mocking: createMockHttpService()
 *   - Sentry Mocking: createMockSentry(), SENTRY_MOCK
 *   - DTO Builders: buildAskQuestionDto()
 *   - Environment Setup: setupTestEnv()
 *   - Mock Assertions: getMockCallArgs(), expectMockCalledWith()
 *
 * Usage:
 *   import {
 *     createMockHttpService,
 *     createMockSentry,
 *     buildAskQuestionDto,
 *     setupTestEnv,
 *   } from '../test-utils/unit-test.helpers';
 *
 * @module test-utils/unit-test.helpers
 */

import { AskQuestionDto } from '../Dto/askQuestion.dto';

// =============================================================================
// HTTP SERVICE MOCKING
// =============================================================================

/**
 * Creates a mock HttpService with jest mock functions for all HTTP methods.
 *
 * All methods return `undefined` by default. Configure return values using
 * `mockReturnValue()` (for synchronous) or RxJS `of()`/`throwError()` for
 * Observable-based responses.
 *
 * @returns Mock object with get, post, put, delete as jest.fn()
 *
 * @example
 * // Basic setup
 * const httpService = createMockHttpService();
 *
 * // Mock successful GET response
 * httpService.get.mockReturnValue(of({ data: { id: 1, name: 'Test' } }));
 *
 * // Mock POST with error
 * httpService.post.mockReturnValue(throwError(() => new Error('Network error')));
 *
 * // Inject into service
 * const service = new MyService(httpService as unknown as HttpService);
 */
export const createMockHttpService = () => ({
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
});

// =============================================================================
// SENTRY MOCKING
// =============================================================================

/**
 * Creates mock Sentry functions for testing error reporting and monitoring.
 *
 * Provides mocks for common Sentry functions:
 *   - setContext: Sets contextual data for error reports
 *   - captureMessage: Captures a message event
 *   - captureException: Captures an exception event
 *   - withScope: Creates an isolated scope for tagging/context
 *
 * @returns Mock Sentry module object
 *
 * @example
 * // In test file, before imports:
 * jest.mock('@sentry/nestjs', () => createMockSentry());
 *
 * // In test, verify Sentry was called:
 * const Sentry = jest.requireMock('@sentry/nestjs');
 * expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error));
 */
export const createMockSentry = () => ({
    setContext: jest.fn(),
    captureMessage: jest.fn(),
    captureException: jest.fn(),
    withScope: jest.fn((callback: (scope: { setTag: jest.Mock; setContext: jest.Mock }) => void) => {
        const scope = { setTag: jest.fn(), setContext: jest.fn() };
        callback(scope);
        return scope;
    }),
});

/**
 * Pre-instantiated Sentry mock for use in jest.mock() calls.
 *
 * Use this when you need to reference the same mock instance across
 * setup and assertions. For isolated tests, prefer createMockSentry().
 *
 * @example
 * // At top of test file (before other imports):
 * jest.mock('@sentry/nestjs', () => require('../test-utils/unit-test.helpers').SENTRY_MOCK);
 *
 * // Later in tests:
 * import { SENTRY_MOCK } from '../test-utils/unit-test.helpers';
 * expect(SENTRY_MOCK.captureMessage).toHaveBeenCalled();
 */
export const SENTRY_MOCK = createMockSentry();

// =============================================================================
// DTO BUILDERS
// =============================================================================

/**
 * Builds a minimal valid AskQuestionDto for testing.
 *
 * Provides sensible defaults for all required fields. Override specific fields
 * to create test scenarios (e.g., missing bookingId, different scope).
 *
 * Default values:
 *   - hostId: 'test-host-id'
 *   - chatId: 'test-chat-id'
 *   - chatMessageId: 'test-message-id'
 *   - question: 'Test question'
 *   - language: 'en'
 *   - hostLanguage: 'en'
 *   - scope: 'inStay'
 *   - bookingId: 'test-booking-id'
 *   - locationId: 'test-location-id'
 *
 * @param overrides - Partial DTO fields to override defaults
 * @returns Complete AskQuestionDto instance
 *
 * @example
 * // Default DTO (in-stay guest with booking)
 * const request = buildAskQuestionDto();
 *
 * // Pre-booking inquiry (no bookingId)
 * const inquiry = buildAskQuestionDto({ scope: 'preBooking', bookingId: undefined });
 *
 * // Unknown scope scenario
 * const unknown = buildAskQuestionDto({ scope: 'unknown', locationId: undefined });
 */
export const buildAskQuestionDto = (overrides: Partial<AskQuestionDto> = {}): AskQuestionDto => ({
    hostId: 'test-host-id',
    chatId: 'test-chat-id',
    chatMessageId: 'test-message-id',
    question: 'Test question',
    language: 'en',
    hostLanguage: 'en',
    scope: 'inStay',
    bookingId: 'test-booking-id',
    locationId: 'test-location-id',
    ...overrides,
}) as AskQuestionDto;

// =============================================================================
// ENVIRONMENT SETUP
// =============================================================================

/**
 * Sets up environment variables for testing with automatic cleanup.
 *
 * Provides default values for commonly needed env vars (API URLs, keys).
 * Returns a cleanup function that restores original values - call this
 * in afterEach() to prevent test pollution.
 *
 * Default environment variables:
 *   - ADMIN_INSTANCE_URL: 'https://admin.test/'
 *   - ADMIN_INSTANCE_X_API_KEY: 'test-api-key'
 *   - OPENAI_API_KEY: 'test-openai-key'
 *
 * @param envOverrides - Additional env vars to set (overrides defaults)
 * @returns Cleanup function to restore original environment
 *
 * @example
 * describe('MyService', () => {
 *   let cleanupEnv: () => void;
 *
 *   beforeEach(() => {
 *     cleanupEnv = setupTestEnv({ CUSTOM_VAR: 'custom-value' });
 *   });
 *
 *   afterEach(() => {
 *     cleanupEnv(); // Restores original env vars
 *   });
 * });
 */
export const setupTestEnv = (envOverrides: Record<string, string> = {}): (() => void) => {
    const defaults: Record<string, string> = {
        ADMIN_INSTANCE_URL: 'https://admin.test/',
        ADMIN_INSTANCE_X_API_KEY: 'test-api-key',
        OPENAI_API_KEY: 'test-openai-key',
    };

    const originalValues: Record<string, string | undefined> = {};

    // Save originals and set test values
    Object.entries({ ...defaults, ...envOverrides }).forEach(([key, value]) => {
        originalValues[key] = process.env[key];
        process.env[key] = value;
    });

    // Return cleanup function
    return () => {
        Object.entries(originalValues).forEach(([key, value]) => {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        });
    };
};

// =============================================================================
// MOCK ASSERTION UTILITIES
// =============================================================================

/**
 * Type-safe way to access mock function call arguments.
 *
 * Provides cleaner syntax than `(mockFn as jest.Mock).mock.calls[0]` pattern.
 * Useful for inspecting URL parameters, headers, and request bodies.
 *
 * @param mockFn - The jest mock function to inspect
 * @param callIndex - Which call to inspect (0 = first call, default)
 * @returns Array of arguments passed to that call, or undefined if call doesn't exist
 *
 * @example
 * // Check URL passed to HTTP service
 * const args = getMockCallArgs(httpService.post);
 * expect(args?.[0]).toBe('https://api.example.com/endpoint');
 *
 * // Check request body (second argument)
 * const body = args?.[1];
 * expect(body.userId).toBe('user-123');
 *
 * // Check second call
 * const secondCallArgs = getMockCallArgs(httpService.post, 1);
 */
export const getMockCallArgs = (
    mockFn: jest.Mock,
    callIndex = 0,
): unknown[] | undefined => {
    return mockFn.mock.calls[callIndex];
};

/**
 * Asserts that a mock was called with specific arguments at a given call index.
 *
 * Provides better error messages than `toHaveBeenCalledWith` for complex objects,
 * and supports partial matching via `expect.objectContaining`.
 *
 * @param mockFn - The jest mock function to verify
 * @param expectedArgs - Array of expected arguments (use undefined to skip checking)
 * @param callIndex - Which call to verify (0 = first call, default)
 *
 * @example
 * // Verify POST was called with correct URL and body
 * expectMockCalledWith(httpService.post, [
 *   'https://api.example.com/endpoint',
 *   { userId: 'user-123', action: 'create' },
 *   { headers: { 'X-API-KEY': 'key' } }
 * ]);
 *
 * // Skip checking first argument (URL), only verify body
 * expectMockCalledWith(httpService.post, [
 *   undefined,  // Skip URL check
 *   { userId: 'user-123' }
 * ]);
 */
export const expectMockCalledWith = (
    mockFn: jest.Mock,
    expectedArgs: unknown[],
    callIndex = 0,
): void => {
    const actualArgs = getMockCallArgs(mockFn, callIndex);
    expect(actualArgs).toBeDefined();
    expectedArgs.forEach((expected, argIndex) => {
        if (expected !== undefined) {
            expect(actualArgs?.[argIndex]).toEqual(expect.objectContaining(expected as object));
        }
    });
};
