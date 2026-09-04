import type { CommandAck, EventEnvelope, ServerError, SessionSnapshot } from '@dnd-lm/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type Socket, io } from 'socket.io-client';

export type Delivery = 'sending' | 'delivered' | 'rejected';

export type ChatLine = {
  key: string;
  sequence: number | null;
  senderId: string;
  content: string;
  recipientType: string;
  visibility: 'public' | 'private';
  channel: 'in_character' | 'ooc';
  triggersDm: boolean;
  delivery: Delivery;
  error?: string;
};

export type RollLine = {
  key: string;
  label: string;
  expression: string;
  dice: number[];
  kept: number;
  modifiers: Array<{ source: string; value: number }>;
  total: number;
};

type Posted = {
  content: string;
  recipient_type: ChatLine['recipientType'];
  visibility: ChatLine['visibility'];
  channel: ChatLine['channel'];
  triggers_dm: boolean;
};

/**
 * One socket per session. Events are applied in sequence order and anything at
 * or below the local high-water mark is dropped, so a resume that overlaps what
 * we already have cannot duplicate a line (M2.4).
 */
export function useSession(sessionId: string, characterId: string | null) {
  const socketRef = useRef<Socket | null>(null);
  const highWater = useRef(0);
  /**
   * The version a mutating command must quote (M5.4). A ref, not the snapshot:
   * two rolls in quick succession would both read the same rendered snapshot
   * and the second would be stale. Chat does not move it — only a mutating
   * resolution does, which is exactly what the server enforces.
   */
  const stateVersion = useRef(0);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [rolls, setRolls] = useState<RollLine[]>([]);
  const [connected, setConnected] = useState(false);

  const applyEvent = useCallback((event: EventEnvelope) => {
    if (event.sequence <= highWater.current) return;
    highWater.current = event.sequence;
    stateVersion.current = Math.max(stateVersion.current, event.state_version);
    if (event.type === 'ROLL_RESULT') {
      const roll = event.payload as unknown as RollLine;
      setRolls((current) => [...current, { ...roll, key: event.event_id }]);
      return;
    }
    if (event.type !== 'MESSAGE_POSTED') return;

    const payload = event.payload as unknown as Posted;
    setLines((current) => [
      ...current,
      {
        key: event.event_id,
        sequence: event.sequence,
        senderId: event.actor.id,
        content: payload.content,
        recipientType: payload.recipient_type,
        visibility: payload.visibility,
        channel: payload.channel,
        triggersDm: payload.triggers_dm,
        delivery: 'delivered',
      },
    ]);
  }, []);

  useEffect(() => {
    const socket = io({
      path: '/ws',
      auth: { sessionId, ...(characterId ? { characterId } : {}) },
      transports: ['websocket'],
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      void socket
        .emitWithAck('resume', { last_sequence: highWater.current })
        .then((response: { snapshot: SessionSnapshot; events: EventEnvelope[] }) => {
          setSnapshot(response.snapshot);
          stateVersion.current = response.snapshot.state_version;
          for (const event of response.events) applyEvent(event);
        });
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('event', applyEvent);

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [sessionId, characterId, applyEvent]);

  /**
   * Both an ack and a STATE_CONFLICT carry the version to quote next, so a
   * client that lost a race catches up from the rejection itself rather than
   * having to refetch the snapshot.
   */
  const absorb = useCallback((result: CommandAck | ServerError) => {
    if (typeof result.state_version === 'number') {
      stateVersion.current = Math.max(stateVersion.current, result.state_version);
    }
  }, []);

  const send = useCallback(
    async (content: string) => {
      const socket = socketRef.current;
      if (!socket) return;

      const commandId = crypto.randomUUID();
      // Rendered immediately as "sending" so the composer never feels laggy;
      // the server's event replaces it once it commits.
      setLines((current) => [
        ...current,
        {
          key: commandId,
          sequence: null,
          senderId: 'me',
          content,
          recipientType: 'table',
          visibility: 'public',
          channel: 'in_character',
          triggersDm: false,
          delivery: 'sending',
        },
      ]);

      const result = (await socket.emitWithAck('command', {
        command_id: commandId,
        type: 'SEND_MESSAGE',
        session_id: sessionId,
        expected_state_version: stateVersion.current,
        payload: { content, channel: 'in_character' },
      })) as CommandAck | ServerError;
      absorb(result);

      setLines((current) =>
        'code' in result
          ? current.map((line) =>
              line.key === commandId
                ? { ...line, delivery: 'rejected', error: result.message }
                : line,
            )
          : // The authoritative line arrives as an event; drop the optimistic one.
            current.filter((line) => line.key !== commandId),
      );
    },
    [sessionId, absorb],
  );

  /** Click-to-roll from the sheet. The dice themselves are rolled server-side. */
  const roll = useCallback(
    async (expression: string) => {
      const socket = socketRef.current;
      if (!socket) return;
      absorb(
        (await socket.emitWithAck('command', {
          command_id: crypto.randomUUID(),
          type: 'ROLL_DICE',
          session_id: sessionId,
          expected_state_version: stateVersion.current,
          payload: { expression, ...(characterId ? { character_id: characterId } : {}) },
        })) as CommandAck | ServerError,
      );
    },
    [sessionId, characterId, absorb],
  );

  return { snapshot, lines, rolls, connected, send, roll };
}
