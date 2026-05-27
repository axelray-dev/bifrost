package governance

import (
	"context"
	"testing"

	"github.com/maximhq/bifrost/core/schemas"
	"github.com/maximhq/bifrost/framework/configstore"
	configstoreTables "github.com/maximhq/bifrost/framework/configstore/tables"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ─── Each* iterator + owner scope tests ───────────────────────────────────

// TestEachBudget_IteratesAllBudgets verifies that EachBudget calls the
// callback for every budget in the store with correct values and scope
// derivation from owner FK columns.
func TestEachBudget_IteratesAllBudgets(t *testing.T) {
	store := newStandaloneStore(t)

	// Populate budgets directly into sync.Map.
	vkID := "vk-test-1"
	teamID := "team-platform"
	store.budgets.Store("b-vk", &configstoreTables.TableBudget{
		ID:           "b-vk",
		CurrentUsage: 75.0,
		MaxLimit:     100.0,
		VirtualKeyID: &vkID,
	})
	store.budgets.Store("b-team", &configstoreTables.TableBudget{
		ID:           "b-team",
		CurrentUsage: 50.0,
		MaxLimit:     200.0,
		TeamID:       &teamID,
	})
	store.budgets.Store("b-global", &configstoreTables.TableBudget{
		ID:           "b-global",
		CurrentUsage: 10.0,
		MaxLimit:     500.0,
	})

	var results []struct {
		id        string
		usage     float64
		limit     float64
		scopeType string
		scopeID   string
	}
	store.EachBudget(func(budgetID string, currentUsage, maxLimit float64, ownerScopeType, ownerScopeID string) {
		results = append(results, struct {
			id        string
			usage     float64
			limit     float64
			scopeType string
			scopeID   string
		}{budgetID, currentUsage, maxLimit, ownerScopeType, ownerScopeID})
	})

	require.Len(t, results, 3)

	byID := make(map[string]struct {
		id        string
		usage     float64
		limit     float64
		scopeType string
		scopeID   string
	})
	for _, r := range results {
		byID[r.id] = r
	}

	// VK-scoped budget.
	assert.Equal(t, 75.0, byID["b-vk"].usage)
	assert.Equal(t, 100.0, byID["b-vk"].limit)
	assert.Equal(t, "virtual_key", byID["b-vk"].scopeType)
	assert.Equal(t, "vk-test-1", byID["b-vk"].scopeID)

	// Team-scoped budget.
	assert.Equal(t, 50.0, byID["b-team"].usage)
	assert.Equal(t, 200.0, byID["b-team"].limit)
	assert.Equal(t, "team", byID["b-team"].scopeType)
	assert.Equal(t, "team-platform", byID["b-team"].scopeID)

	// Global budget (no owner FK).
	assert.Equal(t, 10.0, byID["b-global"].usage)
	assert.Equal(t, 500.0, byID["b-global"].limit)
	assert.Equal(t, "global", byID["b-global"].scopeType)
	assert.Equal(t, "", byID["b-global"].scopeID)
}

// TestEachBudget_ScopePriority verifies that ownerScopeFromBudget returns
// the first non-nil FK in priority order: VirtualKeyID > TeamID >
// CustomerID > ProviderConfigID > global.
func TestEachBudget_ScopePriority(t *testing.T) {
	store := newStandaloneStore(t)

	customerID := "cust-acme"
	providerID := uint(42)

	// Customer-scoped budget.
	store.budgets.Store("b-cust", &configstoreTables.TableBudget{
		ID:           "b-cust",
		CurrentUsage: 30.0,
		MaxLimit:     100.0,
		CustomerID:   &customerID,
	})

	// Provider-scoped budget.
	store.budgets.Store("b-prov", &configstoreTables.TableBudget{
		ID:               "b-prov",
		CurrentUsage:     60.0,
		MaxLimit:         100.0,
		ProviderConfigID: &providerID,
	})

	var custScope, provScope string
	var custScopeID, provScopeID string
	store.EachBudget(func(budgetID string, currentUsage, maxLimit float64, ownerScopeType, ownerScopeID string) {
		switch budgetID {
		case "b-cust":
			custScope = ownerScopeType
			custScopeID = ownerScopeID
		case "b-prov":
			provScope = ownerScopeType
			provScopeID = ownerScopeID
		}
	})

	assert.Equal(t, "customer", custScope)
	assert.Equal(t, "cust-acme", custScopeID)

	assert.Equal(t, "provider", provScope)
	assert.Equal(t, "42", provScopeID) // ProviderConfigID is uint, formatted as string
}

// TestEachBudget_EmptyStore verifies EachBudget works with no budgets.
func TestEachBudget_EmptyStore(t *testing.T) {
	store := newStandaloneStore(t)
	called := false
	store.EachBudget(func(budgetID string, currentUsage, maxLimit float64, ownerScopeType, ownerScopeID string) {
		called = true
	})
	assert.False(t, called, "callback should not be called for empty store")
}

// TestEachBudget_SkipsNilValues verifies EachBudget skips nil map entries.
func TestEachBudget_SkipsNilValues(t *testing.T) {
	store := newStandaloneStore(t)
	store.budgets.Store("b-nil", (*configstoreTables.TableBudget)(nil))
	store.budgets.Store("b-valid", &configstoreTables.TableBudget{
		ID:           "b-valid",
		CurrentUsage: 10.0,
		MaxLimit:     100.0,
	})

	var count int
	store.EachBudget(func(budgetID string, currentUsage, maxLimit float64, ownerScopeType, ownerScopeID string) {
		count++
		assert.Equal(t, "b-valid", budgetID)
	})
	assert.Equal(t, 1, count, "nil entries should be skipped")
}

// TestEachRateLimit_IteratesAllRateLimits verifies that EachRateLimit calls
// the callback for every rate limit with a non-nil TokenMaxLimit, passing
// correct values and scope derivation.
func TestEachRateLimit_IteratesAllRateLimits(t *testing.T) {
	store := newStandaloneStore(t)

	vkID := "vk-rl-1"
	teamID := "team-rl"
	tokenMax := int64(10000)

	store.rateLimits.Store("rl-vk", &configstoreTables.TableRateLimit{
		ID:                "rl-vk",
		TokenCurrentUsage: 8000,
		TokenMaxLimit:     &tokenMax,
		VirtualKeyID:      &vkID,
	})
	store.rateLimits.Store("rl-team", &configstoreTables.TableRateLimit{
		ID:                "rl-team",
		TokenCurrentUsage: 500,
		TokenMaxLimit:     &tokenMax,
		TeamID:            &teamID,
	})

	var results []struct {
		id        string
		usage     int64
		limit     int64
		scopeType string
		scopeID   string
	}
	store.EachRateLimit(func(rateLimitID string, tokenCurrentUsage, tokenMaxLimit int64, ownerScopeType, ownerScopeID string) {
		results = append(results, struct {
			id        string
			usage     int64
			limit     int64
			scopeType string
			scopeID   string
		}{rateLimitID, tokenCurrentUsage, tokenMaxLimit, ownerScopeType, ownerScopeID})
	})

	require.Len(t, results, 2)

	byID := make(map[string]struct {
		id        string
		usage     int64
		limit     int64
		scopeType string
		scopeID   string
	})
	for _, r := range results {
		byID[r.id] = r
	}

	assert.Equal(t, int64(8000), byID["rl-vk"].usage)
	assert.Equal(t, "virtual_key", byID["rl-vk"].scopeType)
	assert.Equal(t, "vk-rl-1", byID["rl-vk"].scopeID)

	assert.Equal(t, int64(500), byID["rl-team"].usage)
	assert.Equal(t, "team", byID["rl-team"].scopeType)
	assert.Equal(t, "team-rl", byID["rl-team"].scopeID)
}

// TestEachRateLimit_SkipsNilTokenMaxLimit verifies that EachRateLimit
// skips rate limits where TokenMaxLimit is nil (only request limits, no
// token limits).
func TestEachRateLimit_SkipsNilTokenMaxLimit(t *testing.T) {
	store := newStandaloneStore(t)

	reqMax := int64(100)
	store.rateLimits.Store("rl-req-only", &configstoreTables.TableRateLimit{
		ID:                  "rl-req-only",
		RequestMaxLimit:     &reqMax,
		RequestCurrentUsage: 50,
		// TokenMaxLimit is nil — should be skipped by EachRateLimit.
	})
	store.rateLimits.Store("rl-token", &configstoreTables.TableRateLimit{
		ID:            "rl-token",
		TokenMaxLimit: &reqMax,
	})

	var count int
	store.EachRateLimit(func(rateLimitID string, tokenCurrentUsage, tokenMaxLimit int64, ownerScopeType, ownerScopeID string) {
		count++
		assert.Equal(t, "rl-token", rateLimitID)
	})
	assert.Equal(t, 1, count, "rate limits without TokenMaxLimit should be skipped")
}

// TestEachRateLimit_EmptyStore verifies EachRateLimit works with no rate limits.
func TestEachRateLimit_EmptyStore(t *testing.T) {
	store := newStandaloneStore(t)
	called := false
	store.EachRateLimit(func(rateLimitID string, tokenCurrentUsage, tokenMaxLimit int64, ownerScopeType, ownerScopeID string) {
		called = true
	})
	assert.False(t, called)
}

// TestEachRequestLimit_IteratesAllRequestLimits verifies that EachRequestLimit
// calls the callback for every rate limit with a non-nil RequestMaxLimit.
func TestEachRequestLimit_IteratesAllRequestLimits(t *testing.T) {
	store := newStandaloneStore(t)

	customerID := "cust-req"
	reqMax := int64(5000)

	store.rateLimits.Store("rl-req1", &configstoreTables.TableRateLimit{
		ID:                  "rl-req1",
		RequestCurrentUsage: 3000,
		RequestMaxLimit:     &reqMax,
		CustomerID:          &customerID,
	})
	store.rateLimits.Store("rl-req2", &configstoreTables.TableRateLimit{
		ID:                  "rl-req2",
		RequestCurrentUsage: 100,
		RequestMaxLimit:     &reqMax,
	})

	var results []struct {
		id        string
		usage     int64
		limit     int64
		scopeType string
		scopeID   string
	}
	store.EachRequestLimit(func(rateLimitID string, requestCurrentUsage, requestMaxLimit int64, ownerScopeType, ownerScopeID string) {
		results = append(results, struct {
			id        string
			usage     int64
			limit     int64
			scopeType string
			scopeID   string
		}{rateLimitID, requestCurrentUsage, requestMaxLimit, ownerScopeType, ownerScopeID})
	})

	require.Len(t, results, 2)

	byID := make(map[string]struct {
		id        string
		usage     int64
		limit     int64
		scopeType string
		scopeID   string
	})
	for _, r := range results {
		byID[r.id] = r
	}

	assert.Equal(t, int64(3000), byID["rl-req1"].usage)
	assert.Equal(t, "customer", byID["rl-req1"].scopeType)
	assert.Equal(t, "cust-req", byID["rl-req1"].scopeID)

	assert.Equal(t, int64(100), byID["rl-req2"].usage)
	assert.Equal(t, "global", byID["rl-req2"].scopeType)
}

// TestEachRequestLimit_SkipsNilRequestMaxLimit verifies that EachRequestLimit
// skips rate limits where RequestMaxLimit is nil.
func TestEachRequestLimit_SkipsNilRequestMaxLimit(t *testing.T) {
	store := newStandaloneStore(t)

	tokenMax := int64(10000)
	store.rateLimits.Store("rl-token-only", &configstoreTables.TableRateLimit{
		ID:            "rl-token-only",
		TokenMaxLimit: &tokenMax,
		// RequestMaxLimit is nil — should be skipped by EachRequestLimit.
	})
	store.rateLimits.Store("rl-req", &configstoreTables.TableRateLimit{
		ID:              "rl-req",
		RequestMaxLimit: &tokenMax,
	})

	var count int
	store.EachRequestLimit(func(rateLimitID string, requestCurrentUsage, requestMaxLimit int64, ownerScopeType, ownerScopeID string) {
		count++
		assert.Equal(t, "rl-req", rateLimitID)
	})
	assert.Equal(t, 1, count, "rate limits without RequestMaxLimit should be skipped")
}

// TestEachRateLimit_CustomerScope verifies customer-scoped rate limits.
func TestEachRateLimit_CustomerScope(t *testing.T) {
	store := newStandaloneStore(t)

	customerID := "cust-acme"
	tokenMax := int64(1000)
	store.rateLimits.Store("rl-cust", &configstoreTables.TableRateLimit{
		ID:                "rl-cust",
		TokenCurrentUsage: 800,
		TokenMaxLimit:     &tokenMax,
		CustomerID:        &customerID,
	})

	var scopeType, scopeID string
	store.EachRateLimit(func(rateLimitID string, tokenCurrentUsage, tokenMaxLimit int64, ownerScopeType, ownerScopeID string) {
		scopeType = ownerScopeType
		scopeID = ownerScopeID
	})
	assert.Equal(t, "customer", scopeType)
	assert.Equal(t, "cust-acme", scopeID)
}

// TestUsageObserver_CallbackPath verifies that UsageTracker calls
// UsageObserver.OnUsageUpdated after UpdateUsage when an observer is
// registered. This exercises the SetUsageObserver wiring path that
// server.go uses: govPlugin.SetUsageObserver(observer).
func TestUsageObserver_CallbackPath(t *testing.T) {
	logger := NewMockLogger()
	store, err := NewLocalGovernanceStore(context.Background(), logger, nil, &configstore.GovernanceConfig{
		VirtualKeys: []configstoreTables.TableVirtualKey{
			*buildVirtualKeyWithBudget("vk1", "sk-test", "Test VK", buildBudgetWithUsage("b1", 100.0, 75.0, "24h")),
		},
	}, nil)
	require.NoError(t, err)

	plugin := &GovernancePlugin{store: store, tracker: NewUsageTracker(context.Background(), store, nil, nil, logger)}

	// Track whether the observer was called.
	observerCalled := false
	var capturedVKID string
	var capturedProvider string

	observer := &testUsageObserver{
		onUsageUpdated: func(vkID string, provider string) {
			observerCalled = true
			capturedVKID = vkID
			capturedProvider = provider
		},
	}
	plugin.SetUsageObserver(observer)

	// Trigger a usage update directly through the tracker.
	update := &UsageUpdate{
		Success:    true,
		Cost:       0.05,
		VirtualKey: "sk-test",
		Provider:   "openai",
		Model:      "gpt-4",
	}
	plugin.tracker.UpdateUsage(context.Background(), update)

	assert.True(t, observerCalled, "OnUsageUpdated should be called after UpdateUsage")
	assert.Equal(t, "vk1", capturedVKID)
	assert.Equal(t, "openai", capturedProvider)
}

// TestUsageObserver_NilObserverNoPanic verifies that UpdateUsage works
// without panicking when no observer is set (the default state).
func TestUsageObserver_NilObserverNoPanic(t *testing.T) {
	logger := NewMockLogger()
	store, err := NewLocalGovernanceStore(context.Background(), logger, nil, &configstore.GovernanceConfig{
		VirtualKeys: []configstoreTables.TableVirtualKey{
			*buildVirtualKeyWithBudget("vk1", "sk-test", "Test VK", buildBudgetWithUsage("b1", 100.0, 75.0, "24h")),
		},
	}, nil)
	require.NoError(t, err)

	plugin := &GovernancePlugin{store: store, tracker: NewUsageTracker(context.Background(), store, nil, nil, logger)}

	// No observer set — should not panic.
	update := &UsageUpdate{
		Success:    true,
		Cost:       0.05,
		VirtualKey: "sk-test",
		Provider:   "openai",
		Model:      "gpt-4",
	}
	assert.NotPanics(t, func() {
		plugin.tracker.UpdateUsage(context.Background(), update)
	})
}

// ─── Test helpers ─────────────────────────────────────────────────────────

// testUsageObserver implements UsageObserver for tests.
type testUsageObserver struct {
	onUsageUpdated func(vkID string, provider string)
}

func (o *testUsageObserver) OnUsageUpdated(ctx context.Context, update *UsageUpdate, vkID string, provider schemas.ModelProvider, model string, teamID string, customerID string) {
	if o.onUsageUpdated != nil {
		o.onUsageUpdated(vkID, string(provider))
	}
}
