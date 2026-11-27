export async function openNavigation(page) {
  const toggle = page.getByRole("button", {name:"Open navigation", exact:true});
  if (await toggle.isVisible() && !(await page.getByRole("dialog", {name:"Navigation",exact:true}).isVisible())) await toggle.click();
}
