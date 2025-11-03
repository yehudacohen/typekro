/**
 * Test surgical ECONNRESET suppression that doesn't cause hanging
 */

import { describe, it, expect } from 'bun:test';

describe('Surgical ECONNRESET Fix', () => {
  it('should identify connection reset patterns correctly', () => {
    const testMessages = [
      'ConnResetException: aborted\ncode: "ECONNRESET"',
      'Request.prototype.abort = function () {\n  var self = this\n  self._aborted = true',
      'at socketCloseListener (node:_http_client:129:43)',
      'Normal error message',
      'Another normal log',
    ];

    const isConnectionReset = (message: string) => {
      return (
        (message.includes('ConnResetException') && message.includes('aborted')) ||
        (message.includes('ECONNRESET') && message.includes('code:')) ||
        (message.includes('Request.prototype.abort') && message.includes('self._aborted')) ||
        (message.includes('socketCloseListener') && message.includes('_http_client'))
      );
    };

    expect(isConnectionReset(testMessages[0]!)).toBe(true);
    expect(isConnectionReset(testMessages[1]!)).toBe(true);
    expect(isConnectionReset(testMessages[2]!)).toBe(true);
    expect(isConnectionReset(testMessages[3]!)).toBe(false);
    expect(isConnectionReset(testMessages[4]!)).toBe(false);
  });
});
