import { describe, expect, it } from 'bun:test';
import { CelEvaluator } from '../../src/core.js';

describe('CelEvaluator Simple', () => {
  it('should create an instance', () => {
    const evaluator = new CelEvaluator();
    expect(evaluator).toBeDefined();
  });
});
