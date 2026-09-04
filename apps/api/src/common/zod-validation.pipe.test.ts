import { BadRequestException } from '@nestjs/common';
import { ClientCommand } from '@dnd-lm/contracts';
import { describe, expect, it } from 'vitest';
import { ZodValidationPipe } from './zod-validation.pipe';

const pipe = new ZodValidationPipe(ClientCommand);

describe('ZodValidationPipe', () => {
  it('returns the parsed value for a valid command', () => {
    const out = pipe.transform({
      command_id: 'cmd_1',
      type: 'RESUME',
      session_id: 'session_12',
      expected_state_version: 3,
      payload: { last_sequence: 184 },
    });
    expect(out.type).toBe('RESUME');
  });

  it('throws a 400 carrying the failing paths, not the raw zod error', () => {
    try {
      pipe.transform({
        command_id: '',
        type: 'RESUME',
        session_id: 's',
        expected_state_version: -1,
      });
      expect.unreachable('expected a BadRequestException');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const body = (error as BadRequestException).getResponse() as {
        code: string;
        issues: unknown[];
      };
      expect(body.code).toBe('INVALID_PAYLOAD');
      expect(body.issues.length).toBeGreaterThan(0);
    }
  });
});
