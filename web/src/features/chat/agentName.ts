import { createContext } from 'react';
import type { Provider } from '../../api/types';

/** provider-parity: the provider of the session whose feed is drawn — its name and mark in answers, questions, plans, permissions. */
export const AgentProvider = createContext<Provider>('claude');
