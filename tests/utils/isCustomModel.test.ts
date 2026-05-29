/**
 * isCustomModel tests — explicitly-configured target model classification.
 *
 * Regression for the false "Microsoft standard model" warning: a model whose
 * ISV prefix is only an abbreviation of its name (e.g. prefix "CR" for model
 * "ContosoRobotics") fails the literal startsWith() heuristic, so before the fix
 * it was misclassified as a standard model until something registered it at runtime.
 *
 * The configured target model (D365FO_MODEL_NAME) is now custom by definition,
 * independent of the prefix — while genuinely unrelated models stay standard.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isCustomModel, clearAutoDetectedModels } from '../../src/utils/modelClassifier';

const originalPrefix = process.env.EXTENSION_PREFIX;
const originalModelName = process.env.D365FO_MODEL_NAME;
const originalCustomModels = process.env.CUSTOM_MODELS;

function restore(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

beforeEach(() => {
  clearAutoDetectedModels();
});

afterEach(() => {
  restore('EXTENSION_PREFIX', originalPrefix);
  restore('D365FO_MODEL_NAME', originalModelName);
  restore('CUSTOM_MODELS', originalCustomModels);
  clearAutoDetectedModels();
});

describe('isCustomModel — explicitly configured target model', () => {
  it('REGRESSION: configured model with an abbreviation prefix is custom', () => {
    // Prefix "CR" is NOT a literal start of "ContosoRobotics" (2nd char is "o", not "R"),
    // so the startsWith() heuristic fails — the configured-model check must catch it.
    process.env.EXTENSION_PREFIX = 'CR';
    process.env.D365FO_MODEL_NAME = 'ContosoRobotics';
    delete process.env.CUSTOM_MODELS;
    clearAutoDetectedModels();

    expect(isCustomModel('ContosoRobotics')).toBe(true);
  });

  it('configured-model match is case-insensitive', () => {
    process.env.D365FO_MODEL_NAME = 'ContosoRobotics';
    delete process.env.EXTENSION_PREFIX;
    delete process.env.CUSTOM_MODELS;
    clearAutoDetectedModels();

    expect(isCustomModel('contosorobotics')).toBe(true);
  });

  it('is scoped to the configured model — an unrelated model stays standard', () => {
    // Proves the fix does not blanket-classify everything as custom.
    process.env.EXTENSION_PREFIX = 'CR';
    process.env.D365FO_MODEL_NAME = 'ContosoRobotics';
    delete process.env.CUSTOM_MODELS;
    clearAutoDetectedModels();

    expect(isCustomModel('GeneralLedger')).toBe(false);
  });

  it('with no configuration at all, an arbitrary Microsoft model is standard', () => {
    delete process.env.EXTENSION_PREFIX;
    delete process.env.D365FO_MODEL_NAME;
    delete process.env.CUSTOM_MODELS;
    clearAutoDetectedModels();

    expect(isCustomModel('ApplicationSuite')).toBe(false);
  });
});

describe('isCustomModel — existing signals still hold', () => {
  it('CUSTOM_MODELS entry is custom', () => {
    delete process.env.EXTENSION_PREFIX;
    delete process.env.D365FO_MODEL_NAME;
    process.env.CUSTOM_MODELS = 'ContosoRoboticsIsvExt,SomeOtherModel';
    clearAutoDetectedModels();

    expect(isCustomModel('ContosoRoboticsIsvExt')).toBe(true);
  });

  it('CUSTOM_MODELS wildcard pattern is custom', () => {
    delete process.env.EXTENSION_PREFIX;
    delete process.env.D365FO_MODEL_NAME;
    process.env.CUSTOM_MODELS = 'ContosoRobotics*';
    clearAutoDetectedModels();

    expect(isCustomModel('ContosoRoboticsTest')).toBe(true);
  });

  it('literal prefix match still classifies as custom', () => {
    // When the prefix genuinely IS the start of the model name.
    process.env.EXTENSION_PREFIX = 'WHS';
    delete process.env.D365FO_MODEL_NAME;
    delete process.env.CUSTOM_MODELS;
    clearAutoDetectedModels();

    expect(isCustomModel('WHSCustomExtensions')).toBe(true);
  });
});
