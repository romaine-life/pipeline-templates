# The OpenTofu providers every repository on the tofu suite runs with, at one version each
# (IB-3). A repository declares the providers it uses by source alone, with no version: this
# set decides them, and the suite gives every repository this directory's lock before
# `tofu init -lockfile=readonly` (common.mjs). The lock beside this file is written by CI only
# (providers.mjs, .forgejo/workflows/tofu-providers.yml), never by hand: a pull request that
# changes this file gets its lock pushed by CI. A repository needing a provider not here adds
# it here.
terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "4.71.0"
    }
    azuread = {
      source  = "hashicorp/azuread"
      version = "3.8.0"
    }
    azapi = {
      source  = "azure/azapi"
      version = "2.9.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "3.9.0"
    }
    external = {
      source  = "hashicorp/external"
      version = "2.3.5"
    }
    github = {
      source  = "integrations/github"
      version = "6.12.1"
    }
    vault = {
      source  = "hashicorp/vault"
      version = "5.13.0"
    }
    # Nelson's fork of svalabs/forgejo, with import for forgejo_repository_action_variable.
    forgejo = {
      source  = "artifacts.home.romaine.life/romaine-life/forgejo"
      version = "1.7.1"
    }
    openproject = {
      source  = "artifacts.home.romaine.life/romaine-life/openproject"
      version = "0.1.0"
    }
  }
}
