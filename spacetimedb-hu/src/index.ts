import { pokerArena } from '@pokerarena/shared/holdem';

const arena = pokerArena(2);
export default arena.db;
export const { init, tick, register, issueDeployCode, deployBot, setAccountBanned, disconnect, submitAction, setPaused, removeBot, standings, myTurn } = arena;
