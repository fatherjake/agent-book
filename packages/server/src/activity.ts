/**
 * Work the web server is doing in the background (lab analyses and replays, chat replies). A server
 * started by the Dock app stops itself once no window is open, but never while any of this is running.
 */
const busy = new Set<string>();

export const markBusy = (id: string) => void busy.add(id);
export const markIdle = (id: string) => void busy.delete(id);
export const isWorking = () => busy.size > 0;
