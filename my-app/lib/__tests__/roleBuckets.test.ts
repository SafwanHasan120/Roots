import { describe, expect, it } from 'vitest';
import { rolesFor } from '../roleBuckets';

describe('roleBuckets', () => {
  it('does not put specialized engineers in SWE', () => {
    expect(rolesFor('Data Engineer Intern')).toEqual(['Data']);
    expect(rolesFor('Firmware Engineer Intern')).toEqual(['Hardware']);
    expect(rolesFor('Machine Learning Engineer Intern')).toEqual(['ML/AI']);
    expect(rolesFor('ASIC Engineer Intern')).toEqual(['Hardware']);
  });

  it('keeps a software role on an infrastructure team in SWE only', () => {
    expect(rolesFor('Software Engineer Intern, Infrastructure')).toEqual(['SWE']);
    expect(rolesFor('Software Engineer Intern, Production Infrastructure')).toEqual(['SWE']);
  });

  it('treats design verification as hardware, not design', () => {
    expect(rolesFor('Design Verification Engineer Intern')).toEqual(['Hardware']);
    expect(rolesFor('Physical Design Engineer Intern')).toEqual(['Hardware']);
    expect(rolesFor('FPGA Design Intern')).toEqual(['Hardware']);
  });

  it('tags titles the old patterns missed', () => {
    expect(rolesFor('Artificial Intelligence Intern')).toEqual(['ML/AI']);
    expect(rolesFor('Applied Scientist Intern')).toEqual(['ML/AI']);
    expect(rolesFor('Cybersecurity Intern')).toEqual(['Security']);
    expect(rolesFor('Cyber Security Co-op')).toEqual(['Security']);
    expect(rolesFor('Information Security Intern')).toEqual(['Security']);
    expect(rolesFor('Product Owner Intern')).toEqual(['Product']);
    expect(rolesFor('Application Development Intern')).toEqual(['SWE']);
  });

  it('tags Software Engineer, Machine Learning as both SWE and ML/AI', () => {
    expect(rolesFor('Software Engineer, Machine Learning')).toEqual(['SWE', 'ML/AI']);
  });

  it('tags platform and cloud roles as DevOps without swallowing software titles', () => {
    expect(rolesFor('Platform Engineer Intern')).toEqual(['DevOps/Infra']);
    expect(rolesFor('Cloud Engineer Intern')).toEqual(['DevOps/Infra']);
    expect(rolesFor('DevOps Intern')).toEqual(['DevOps/Infra']);
    expect(rolesFor('Site Reliability Engineer Intern, Data Infra')).toEqual(['DevOps/Infra']);
    expect(rolesFor('Software Engineering Intern, Embedded Platforms')).toEqual(['SWE', 'Hardware']);
  });

  it('does not treat production or research analyst as product or quant', () => {
    expect(rolesFor('Production Business Intelligence Intern')).toEqual(['Data']);
    expect(rolesFor('Research Analyst Intern')).toEqual([]);
    expect(rolesFor('Quantitative Trading Intern')).toEqual(['Quant']);
  });

  it('puts a generic engineering intern in SWE and a UI software role in both', () => {
    expect(rolesFor('Engineering Intern')).toEqual(['SWE']);
    expect(rolesFor('Campus UI Software Engineer Intern')).toEqual(['SWE', 'Design/UX']);
    expect(rolesFor('Product Design Engineer Intern')).toEqual(['Design/UX']);
  });
});
