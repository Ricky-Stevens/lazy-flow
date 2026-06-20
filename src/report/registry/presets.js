const PROXY_NOTE =
  'DORA bands are suppressed when deploy/incident data is a proxy (merge-to-default / Jira reopen).'

export const PRESETS = [
  {
    key: 'sprint:team',
    title: 'Sprint Review Report',
    audience: 'Engineering Manager + team',
    scopeType: 'team',
    cadence: 'sprint',
    blindSpots: ['No wellbeing/morale signal — local tool cannot run surveys.', PROXY_NOTE],
    sections: [
      {
        id: 'delivery',
        title: 'Delivery Speed & Stability',
        purpose: 'Did we ship safely this sprint?',
        metrics: [
          {
            metricId: 'dora.deployment_frequency',
            label: 'Deploy frequency',
            unit: 'per day',
            chart: 'dora_band_gauge',
            proxy: true,
          },
          {
            metricId: 'dora.lead_time',
            label: 'Lead time',
            unit: 'hours',
            chart: 'trend',
            proxy: true,
          },
          {
            metricId: 'dora.change_failure_rate',
            label: 'Change failure rate',
            unit: '%',
            proxy: true,
          },
        ],
      },
      {
        id: 'flow',
        title: 'Where Work Got Stuck',
        purpose: 'Flow + PR pipeline bottlenecks to unblock.',
        metrics: [
          { metricId: 'flow.cycle_time', label: 'Cycle time', unit: 'hours', chart: 'trend' },
          { metricId: 'flow.flow_efficiency', label: 'Flow efficiency', unit: '%' },
          {
            metricId: 'pr.time_to_first_review',
            label: 'Time to first review',
            unit: 'hours',
            chart: 'trend',
          },
          {
            metricId: 'flow.aging_wip',
            label: 'Aging WIP (p50 age)',
            unit: 'days',
            chart: 'distribution_bar',
          },
        ],
      },
      {
        id: 'commitment',
        title: 'Did We Deliver What We Said?',
        purpose: 'Predictability of the sprint commitment.',
        metrics: [
          { metricId: 'agile.say_do', label: 'Say/do ratio', unit: '%', chart: 'trend' },
          {
            metricId: 'agile.sprint_velocity',
            label: 'Latest sprint velocity',
            unit: 'points',
            chart: 'trend',
          },
          { metricId: 'flow.throughput', label: 'Throughput', unit: 'count', chart: 'trend' },
        ],
      },
      {
        id: 'investment',
        title: 'Investment Allocation',
        purpose:
          'Where the team spent its delivery capacity this sprint — feature vs bug vs ' +
          'debt vs other (Pluralsight/Jellyfish-style allocation view).',
        metrics: [
          {
            metricId: 'flow.flow_distribution',
            label: 'Work-type allocation',
            unit: 'count',
            chart: 'stacked_bar',
          },
        ],
        caveats: [
          'Allocation is a deterministic Jira issue-type split (feature/bug/debt/other), ' +
            'not effort or cost. Mislabelled issue types skew the mix.',
        ],
      },
    ],
  },
  {
    key: 'monthly:team',
    title: 'Monthly Delivery Report',
    audience: 'Engineering Manager',
    scopeType: 'team',
    cadence: 'monthly',
    blindSpots: ['No wellbeing/morale signal — local tool cannot run surveys.', PROXY_NOTE],
    sections: [
      {
        id: 'delivery',
        title: 'Delivery Speed & Stability',
        purpose: 'Month-over-month delivery health.',
        metrics: [
          {
            metricId: 'dora.lead_time',
            label: 'Lead time',
            unit: 'hours',
            chart: 'trend',
            proxy: true,
          },
          {
            metricId: 'dora.deployment_frequency',
            label: 'Deploy frequency',
            unit: 'per day',
            proxy: true,
          },
          {
            metricId: 'dora.change_failure_rate',
            label: 'Change failure rate',
            unit: '%',
            proxy: true,
          },
        ],
      },
      {
        id: 'flow',
        title: 'Flow Bottlenecks',
        purpose: 'Where delivery is silting up.',
        metrics: [
          { metricId: 'flow.cycle_time', label: 'Cycle time', unit: 'hours', chart: 'trend' },
          { metricId: 'flow.flow_efficiency', label: 'Flow efficiency', unit: '%', chart: 'trend' },
          { metricId: 'pr.review_latency', label: 'Review latency', unit: 'hours' },
          { metricId: 'flow.aging_wip', label: 'Aging WIP (p50 age)', unit: 'days' },
        ],
      },
      {
        id: 'commitment',
        title: 'Predictability & Forecast',
        purpose: 'Can we forecast? Including a Monte Carlo completion horizon.',
        metrics: [
          { metricId: 'agile.say_do', label: 'Say/do ratio', unit: '%', chart: 'trend' },
          { metricId: 'agile.sprint_predictability', label: 'Sprint predictability', unit: '%' },
          {
            metricId: 'agile.sprint_velocity',
            label: 'Latest sprint velocity',
            unit: 'points',
            chart: 'trend',
          },
          {
            metricId: 'agile.estimation_accuracy',
            label: 'Estimation accuracy',
            unit: 'ratio',
          },
          {
            metricId: 'flow.monte_carlo_forecast',
            label: 'Forecast to clear WIP (p50)',
            unit: 'weeks',
            chart: 'trend',
          },
        ],
        caveats: [
          'Forecast is a bootstrap over historical weekly throughput; high percentiles ' +
            'are suppressed until the throughput history meets the sample floor.',
        ],
      },
    ],
  },
  {
    key: 'quarterly:dept',
    title: 'Quarterly Business Review (QBR)',
    audience: 'VP / Director of Engineering',
    scopeType: 'org',
    cadence: 'quarterly',
    blindSpots: [
      'No cost/ROI/business-outcome data — out of scope for a delivery tool.',
      'No wellbeing signal.',
      PROXY_NOTE,
    ],
    sections: [
      {
        id: 'risk',
        title: 'Delivery Risk & DORA Position',
        purpose: 'Quarterly delivery risk for the department.',
        metrics: [
          {
            metricId: 'dora.lead_time',
            label: 'Lead time',
            unit: 'hours',
            chart: 'trend',
            proxy: true,
            benchmark: true,
          },
          {
            metricId: 'dora.deployment_frequency',
            label: 'Deploy frequency',
            unit: 'per day',
            proxy: true,
            benchmark: true,
          },
          {
            metricId: 'dora.change_failure_rate',
            label: 'Change failure rate',
            unit: '%',
            proxy: true,
            benchmark: true,
          },
          {
            metricId: 'dora.recovery_time',
            label: 'Recovery time',
            unit: 'hours',
            proxy: true,
            benchmark: true,
          },
        ],
      },
      {
        id: 'flow',
        title: 'Where PRs Die',
        purpose: 'Systemic flow drag across the department.',
        metrics: [
          { metricId: 'flow.cycle_time', label: 'Cycle time', unit: 'hours', chart: 'trend' },
          { metricId: 'flow.flow_efficiency', label: 'Flow efficiency', unit: '%' },
          { metricId: 'pr.cycle_time', label: 'PR cycle time', unit: 'hours' },
        ],
      },
    ],
  },
  {
    key: 'monthly:company',
    title: 'Executive Delivery Summary',
    audience: 'CTO / CEO (exported, presented by the operator)',
    scopeType: 'org',
    cadence: 'monthly',
    blindSpots: [
      'No cost/ROI/business-outcome data.',
      'No wellbeing signal.',
      'No real deploy/incident feed unless connected — DORA may be proxy-mode.',
    ],
    sections: [
      {
        id: 'headline',
        title: 'Delivery & Stability',
        purpose: 'Are we delivering predictably and safely as we scale?',
        metrics: [
          {
            metricId: 'dora.lead_time',
            label: 'Lead time',
            unit: 'hours',
            chart: 'trend',
            proxy: true,
            benchmark: true,
          },
          {
            metricId: 'dora.change_failure_rate',
            label: 'Change failure rate',
            unit: '%',
            proxy: true,
            benchmark: true,
          },
          { metricId: 'flow.throughput', label: 'Throughput', unit: 'count', chart: 'trend' },
          { metricId: 'flow.aging_wip', label: 'Aging WIP (p50 age)', unit: 'days' },
        ],
      },
      {
        id: 'flowrisk',
        title: 'Flow Risk',
        purpose: 'Where delivery is silting up.',
        metrics: [
          { metricId: 'flow.cycle_time', label: 'Cycle time', unit: 'hours', chart: 'trend' },
          { metricId: 'flow.flow_efficiency', label: 'Flow efficiency', unit: '%' },
        ],
      },
    ],
  },
  {
    key: 'annual:company',
    title: 'Annual Engineering Report',
    audience: 'CTO / CEO (exported)',
    scopeType: 'org',
    cadence: 'annual',
    blindSpots: [
      'No cost/ROI/business-outcome data.',
      'No wellbeing/attrition signal.',
      'Internal-trend only — no per-engineer evaluation.',
    ],
    sections: [
      {
        id: 'year',
        title: 'Year in Review — Internal Trend',
        purpose: 'YoY delivery effectiveness (self-baseline).',
        metrics: [
          {
            metricId: 'dora.lead_time',
            label: 'Lead time',
            unit: 'hours',
            chart: 'trend',
            proxy: true,
          },
          { metricId: 'flow.throughput', label: 'Throughput', unit: 'count', chart: 'trend' },
          { metricId: 'flow.cycle_time', label: 'Cycle time', unit: 'hours', chart: 'trend' },
          { metricId: 'agile.say_do', label: 'Say/do ratio', unit: '%' },
        ],
      },
      {
        id: 'health',
        title: 'Codebase Health Trajectory',
        purpose: 'Is speed costing maintainability?',
        metrics: [
          {
            metricId: 'code.maintainability_index',
            label: 'Maintainability index',
            unit: 'index',
            chart: 'trend',
          },
          {
            metricId: 'code.change_impact',
            label: 'Code change impact',
            unit: 'ratio',
            chart: 'trend',
          },
          { metricId: 'code.rework_churn', label: 'Rework churn', unit: '%' },
        ],
      },
    ],
  },
  {
    key: 'monthly:team.risk',
    title: 'Engineering Health & Risk Report',
    audience: 'EM / Principal',
    scopeType: 'team',
    cadence: 'monthly',
    blindSpots: ['Operational load only — not a wellbeing/burnout measure.', PROXY_NOTE],
    sections: [
      {
        id: 'risk',
        title: 'Operational Risk Signals',
        purpose: 'Early warning on flow + review load (operational, not morale).',
        metrics: [
          {
            metricId: 'flow.aging_wip',
            label: 'Aging WIP (p50 age)',
            unit: 'days',
            chart: 'trend',
          },
          { metricId: 'flow.wip_load', label: 'WIP load', unit: 'count' },
          { metricId: 'pr.reviewer_load_gini', label: 'Reviewer load (Gini)', unit: 'index' },
          { metricId: 'pr.review_coverage', label: 'Review coverage', unit: '%' },
          { metricId: 'pr.review_latency', label: 'Review latency', unit: 'hours', chart: 'trend' },
        ],
        caveats: [
          'Reviewer-load concentration is a flow-distribution signal, not a wellbeing measure.',
        ],
      },
      {
        id: 'codebase',
        title: 'Codebase Hotspots',
        purpose: 'Where the code is rotting (repo-scoped, never per-person).',
        metrics: [
          { metricId: 'code.complexity_delta', label: 'Complexity delta', unit: 'index' },
          {
            metricId: 'code.haloc_aggregate',
            label: 'Churn (HALOC)',
            unit: 'count',
            chart: 'trend',
          },
          {
            metricId: 'code.nagappan_ball',
            label: 'Relative churn (Nagappan-Ball)',
            unit: 'ratio',
          },
          { metricId: 'code.change_impact', label: 'Code change impact', unit: 'ratio' },
          { metricId: 'code.rework_churn', label: 'Rework churn', unit: '%' },
        ],
      },
    ],
  },
  {
    key: 'quarterly:company.benchmark',
    title: 'Company Baseline & Industry Benchmark',
    audience: 'CTO / VP (exported)',
    scopeType: 'org',
    cadence: 'quarterly',
    blindSpots: [
      'Industry benchmarks apply at org scope only; person-scope comparison is statistically invalid.',
      'Only DORA is a clean, redistributable benchmark; vendor ranges are heuristic guidance.',
    ],
    sections: [
      {
        id: 'dora',
        title: 'DORA vs Industry',
        purpose: 'Company position against DORA bands (real data only).',
        metrics: [
          {
            metricId: 'dora.lead_time',
            label: 'Lead time',
            unit: 'hours',
            chart: 'trend',
            proxy: true,
            benchmark: true,
          },
          {
            metricId: 'dora.deployment_frequency',
            label: 'Deploy frequency',
            unit: 'per day',
            proxy: true,
            benchmark: true,
          },
          {
            metricId: 'dora.change_failure_rate',
            label: 'Change failure rate',
            unit: '%',
            proxy: true,
            benchmark: true,
          },
          {
            metricId: 'dora.recovery_time',
            label: 'Recovery time',
            unit: 'hours',
            proxy: true,
            benchmark: true,
          },
        ],
      },
    ],
  },
  {
    key: 'annual:person',
    title: 'Personal Flow & Load Context',
    audience: 'Engineer (self) — private self-view',
    scopeType: 'person',
    cadence: 'annual',
    personScope: true,
    blindSpots: [
      'A narrow flow slice — does NOT measure scope, judgment, mentorship, or impact. Not for appraisal.',
      'Self-baseline only; no comparison to other people; no industry benchmark.',
      'Coverage gaps mean "not visible", never "no work".',
    ],
    sections: [
      {
        id: 'change',
        title: 'What Changed This Year — Or Didn’t',
        purpose: 'Your own flow vs your own baseline.',
        metrics: [
          { metricId: 'flow.cycle_time', label: 'Cycle time', unit: 'hours', chart: 'trend' },
          { metricId: 'pr.cycle_time', label: 'PR cycle time', unit: 'hours', chart: 'trend' },
        ],
      },
      {
        id: 'load',
        title: 'Review Turnaround & Carrying Load',
        purpose: 'Sustainability tripwire vs your own normal — never vs peers.',
        metrics: [
          { metricId: 'pr.review_latency', label: 'Review latency you give', unit: 'hours' },
          { metricId: 'flow.aging_wip', label: 'Aging in-flight work (p50 age)', unit: 'days' },
        ],
      },
    ],
  },
  {
    key: 'weekly:team',
    title: 'Weekly Team Pulse',
    audience: 'Engineering Manager',
    scopeType: 'team',
    cadence: 'weekly',
    blindSpots: [
      'Small weekly samples — most deltas will read "within normal variance".',
      PROXY_NOTE,
    ],
    sections: [
      {
        id: 'pulse',
        title: 'This Week vs Baseline',
        purpose: 'Quick weekly heartbeat — act on what moved.',
        metrics: [
          { metricId: 'flow.throughput', label: 'Throughput', unit: 'count', chart: 'sparkline' },
          {
            metricId: 'pr.time_to_first_review',
            label: 'Time to first review',
            unit: 'hours',
            chart: 'sparkline',
          },
          { metricId: 'flow.aging_wip', label: 'Aging WIP (p50 age)', unit: 'days' },
        ],
      },
    ],
  },
]
