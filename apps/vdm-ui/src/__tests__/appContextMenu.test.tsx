import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppContextMenu } from "@/components/ui/AppContextMenu";

function renderHost(children: React.ReactNode) {
  return render(
    <MemoryRouter>
      <div>{children}</div>
      <AppContextMenu />
    </MemoryRouter>,
  );
}

/** Dispatch a real contextmenu event and report whether the default was kept. */
function rightClick(el: Element): boolean {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 });
  el.dispatchEvent(event);
  return !event.defaultPrevented;
}

describe("AppContextMenu", () => {
  it("suppresses the native menu and opens the VDM menu on plain content", async () => {
    renderHost(<p>hello</p>);
    const nativeShown = rightClick(screen.getByText("hello"));
    expect(nativeShown).toBe(false);
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
    expect(screen.getByText("Reload")).toBeTruthy();
    expect(screen.getByText("Back")).toBeTruthy();
  });

  it("renders the menu in a portal on <body>, outside the app subtree", async () => {
    const { container } = renderHost(<p>hello</p>);
    rightClick(screen.getByText("hello"));
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
    const menu = screen.getByRole("menu");
    expect(container.contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
  });

  it("offers clipboard actions inside a text field", async () => {
    renderHost(<input defaultValue="abc" aria-label="field" />);
    rightClick(screen.getByLabelText("field"));
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
    for (const label of ["Cut", "Copy", "Paste", "Select all"]) {
      expect(screen.getByText(label), `missing "${label}"`).toBeTruthy();
    }
  });

  it("offers link actions on an anchor", async () => {
    renderHost(<a href="/tasks">tasks</a>);
    rightClick(screen.getByText("tasks"));
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
    expect(screen.getByText("Open in new tab")).toBeTruthy();
    expect(screen.getByText("Copy link address")).toBeTruthy();
  });

  it("stays out of the way when a component opens its own menu", async () => {
    renderHost(<div data-testid="own" onContextMenu={(e) => e.preventDefault()}>row</div>);
    const nativeShown = rightClick(screen.getByTestId("own"));
    expect(nativeShown).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText("Reload")).toBeNull();
  });

  it("lets console surfaces keep the raw event", () => {
    renderHost(<canvas data-testid="console" />);
    // Not prevented here: VNC/SPICE/xterm need the untouched event.
    expect(rightClick(screen.getByTestId("console"))).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
