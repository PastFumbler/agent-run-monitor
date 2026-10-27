export const meta = {
  name: 'review-due-dates',
  description: 'Review the due-date change with two reviewers',
  phases: [{ title: 'Review' }],
}

export default async function run(wf) {
  const [logic, tests] = await Promise.all([
    wf.agent({ label: 'review:logic', phase: 'Review', prompt: 'Review the change.' }),
    wf.agent({ label: 'review:tests', phase: 'Review', prompt: 'Check test coverage.' }),
  ])
  return { logic, tests }
}
