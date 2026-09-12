/**
 * Simulator connection settings, read from the environment.
 *
 * SIM_ORIGIN  base URL of the simulator (for example https://sim.animahacks.com
 *             or http://localhost:8080 for a local instance)
 * SIM_KEY     team API key returned by POST /api/keys
 */
export interface SimConfig {
  origin: string
  apiKey?: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SimConfig {
  const origin = (env.SIM_ORIGIN ?? 'https://sim.animahacks.com').replace(/\/+$/, '')
  const apiKey = env.SIM_KEY?.trim() || undefined
  return { origin, apiKey }
}

export function requireApiKey(config: SimConfig): string {
  if (!config.apiKey) {
    throw new Error('SIM_KEY is not set. Copy your team key from the simulator or create one with SimClient.createTeam().')
  }
  return config.apiKey
}
