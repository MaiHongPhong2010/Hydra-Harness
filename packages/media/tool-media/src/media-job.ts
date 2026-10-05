/** Non-secret provider job correlation carried by completed media responses. */

/** Read a validated local recovery id without admitting provider URLs into metadata.
 * @param response - Completed media response.
 * @returns A local UUID, or undefined for providers without saved-task recovery.
 */
export function mediaJobId(response: Response): string | undefined {
  const id = response.headers.get('x-hydra-job-id')
  return id !== null && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id) ? id : undefined
}
