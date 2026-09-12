/**
 * Simulator connection settings, read from the environment.
 *
 * SIM_ORIGIN  base URL of the simulator (for example https://sim.animahacks.com
 *             or http://localhost:8080 for a local instance)
 * SIM_KEY     team API key returned by POST /api/keys
 */
import { existsSync } from 'node:fs'

export interface SimConfig {
  origin: string
  apiKey?: string
}

/**
 * Loads a .env file from the current directory into process.env, if one
 * exists. Existing variables are not overridden. Safe to call repeatedly.
 */
export function loadDotEnv(path = '.env'): boolean {
  if (!existsSync(path)) return false
  try {
    process.loadEnvFile(path)
    return true
  } catch {
    return false
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SimConfig {
  if (env === process.env) loadDotEnv()
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
