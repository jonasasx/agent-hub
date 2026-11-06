/**
 * The filter «Машина: X» of the sessions list (Requirement «Окно „Машины“»: «Сессии машины» in the machine menu).
 * Not stored: it is a view of the moment, a reload shows all sessions.
 */
import { create } from 'zustand';

interface MachineFilter {
  runnerId: string | null;
  set: (runnerId: string | null) => void;
}

export const useMachineFilter = create<MachineFilter>(set => ({ runnerId: null, set: runnerId => set({ runnerId }) }));
